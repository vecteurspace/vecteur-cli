// What the CLI's stop card says when a turn ends in `budget`. The CLI owns these words: the web's v5 owner
// (`frontend/src/run/stop-words.ts`) went with the v6 run screen, and only the keys `format.js` reads are kept.
// Facts are never written here: `{model}` comes from the catalogue, `{steps}` and `{price}` from the plan owner.
export const STOP_WORDS = Object.freeze({
  heading: { limit: "This study paused at a limit" },
  reason: { limit: "{model} needs more room for its next step than is left for this period." },
  result: {
    authored: "Your computed work is saved, and what was written before the stop is below.",
    computed: "What ran is listed below; no final answer to your question was delivered.",
    nothing: "Nothing was computed yet. Your question is kept.",
  },
  usage_note: "A step reserves room before it runs, so this can appear before your usage reads full.",
  action_line: {
    upgrade_plan: "Room for longer studies: up to {steps} steps per run and a larger usage allowance. {price}.",
    contact_sales: "If your studies regularly need more than Pro allows, we'll work out what fits.",
  },
  continue_with: "Continue with {model}",
  see_usage: "See usage",
});
