from dataclasses import dataclass

LUNA_INPUT_PER_M = 0.20
LUNA_CACHED_INPUT_PER_M = 0.02
LUNA_OUTPUT_PER_M = 1.20


def luna_cost(input_tokens: int, cached_input_tokens: int, output_tokens: int) -> float:
    cached = max(0, min(int(cached_input_tokens), int(input_tokens)))
    uncached = max(0, int(input_tokens) - cached)
    return (
        uncached * LUNA_INPUT_PER_M
        + cached * LUNA_CACHED_INPUT_PER_M
        + max(0, int(output_tokens)) * LUNA_OUTPUT_PER_M
    ) / 1_000_000


def rough_tokens(text: str) -> int:
    return max(1, (len(str(text)) + 3) // 4)


@dataclass(frozen=True)
class BudgetGovernor:
    hard_budget_usd: float = 30.0
    max_output_tokens: int = 4096

    def preflight(self, current_month_usd: float, prompt: str) -> dict:
        estimated_input = rough_tokens(prompt)
        estimated = luna_cost(estimated_input, 0, self.max_output_tokens) + (estimated_input * LUNA_INPUT_PER_M * 0.25 / 1_000_000)
        allowed = current_month_usd + estimated <= self.hard_budget_usd
        return {"allowed": allowed, "estimated_usd": estimated, "estimated_input_tokens": estimated_input}
