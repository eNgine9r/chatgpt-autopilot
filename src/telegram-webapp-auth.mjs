import crypto from "node:crypto";

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function validateTelegramInitData(initData, { botToken, ownerUserId, now = () => Date.now(), maxAgeSeconds = 3600 }) {
  if (!botToken || !ownerUserId || !initData) return { ok: false, error: "telegram_auth_not_configured" };
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  params.delete("hash");
  params.delete("signature");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!timingSafeHexEqual(receivedHash, expected)) return { ok: false, error: "invalid_signature" };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.abs(Math.floor(now() / 1000) - authDate) > maxAgeSeconds) {
    return { ok: false, error: "expired_init_data" };
  }
  let user;
  try { user = JSON.parse(params.get("user") || "{}"); } catch { return { ok: false, error: "invalid_user" }; }
  if (String(user.id || "") !== String(ownerUserId)) return { ok: false, error: "forbidden_user" };
  return { ok: true, user };
}
