import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { validateTelegramInitData } from "../src/telegram-webapp-auth.mjs";

function signedInitData({ token, userId, authDate, signature = "" }) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "q1", user: JSON.stringify({ id: userId, first_name: "Owner" }) });
  if (signature) params.set("signature", signature);
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("validates Telegram init data and restricts owner", () => {
  const token = "123:test";
  const now = 1_800_000_000_000;
  const initData = signedInitData({ token, userId: 42, authDate: Math.floor(now/1000) });
  assert.equal(validateTelegramInitData(initData, { botToken: token, ownerUserId: "42", now: () => now }).ok, true);
  assert.equal(validateTelegramInitData(initData, { botToken: token, ownerUserId: "43", now: () => now }).error, "forbidden_user");
});


test("includes Telegram signature field in bot-token data-check-string", () => {
  const token = "123:test";
  const now = 1_800_000_000_000;
  const initData = signedInitData({
    token, userId: 42, authDate: Math.floor(now/1000),
    signature: "telegram-ed25519-signature-placeholder"
  });
  assert.equal(validateTelegramInitData(initData, { botToken: token, ownerUserId: "42", now: () => now }).ok, true);
});

test("rejects tampered and expired init data", () => {
  const token = "123:test";
  const now = 1_800_000_000_000;
  const initData = signedInitData({ token, userId: 42, authDate: Math.floor(now/1000) });
  assert.equal(validateTelegramInitData(`${initData}x`, { botToken: token, ownerUserId: "42", now: () => now }).ok, false);
  const old = signedInitData({ token, userId: 42, authDate: Math.floor(now/1000)-7200 });
  assert.equal(validateTelegramInitData(old, { botToken: token, ownerUserId: "42", now: () => now }).error, "expired_init_data");
});
