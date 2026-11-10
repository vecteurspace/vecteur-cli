/** v5 §2.5, CU-4 parity: the closed Produce entries, in the words of the cockpit's Produce panel (`ProducePanel.vue`; its spec
 * holds this table to the panel). The same intent has one mode on every door. This is the grammar only: which entry is
 * available is the run door's alone (A38, `backend/src/vecteur/contract/produce-availability.json`), and its refusal
 * `produce_unavailable` names the entry. */
import { CliError } from "./client.js";

const documents = { field: "profile", choices: ["nasa", "esa"] };
const code = { field: "standard", choices: ["vecteur", "nasa", "user"] };
const standalone = target => ({ mode: "standalone", target, ...code });

export const PRODUCE_ENTRIES = {
  business: { fleet_market_benchmark: { mode: "fleet_market_benchmark" } },
  knowledge: {
    mrd: { mode: "mrd", ...documents }, srd: { mode: "srd", ...documents }, dddj: { mode: "dddj", ...documents },
    ard: { mode: "ard", ...documents }, ingest: { mode: "ingest" },
  },
  code: {
    numpy_scipy: standalone("numpy_scipy"), orekit: standalone("orekit"), spice: standalone("spice"),
    gmat: standalone("gmat"), basilisk: standalone("basilisk"), integrate: { mode: "integrate", ...code },
    // The coding agent: no target and no standard; the host re-runs the tests it delivers.
    standalone: { mode: "standalone" },
  },
};

const USAGE = `Use /produce business <ask> or /produce knowledge <${Object.keys(PRODUCE_ENTRIES.knowledge).join("|")}> [profile=nasa|esa] <ask>; `
  + "a knowledge document needs a completed analysis in this Project first";

/** `<specialist> [entry] [field=choice] <ask>` -> { ask, intent }. Business has one entry; the others name theirs. An absent
 * choice is the panel's first option. Anything else sends nothing. */
export function produceIntent(argument) {
  const match = /^(business|knowledge|code)\s+([\s\S]+)$/.exec(argument.trim());
  if (!match) throw new CliError("usage_invalid", USAGE);
  const specialist = match[1];
  let rest = match[2].trim();
  let name = "fleet_market_benchmark";
  if (specialist !== "business") {
    const head = /^(\S+)\s+([\s\S]+)$/.exec(rest);
    if (!head || !Object.hasOwn(PRODUCE_ENTRIES[specialist], head[1])) throw new CliError("usage_invalid", USAGE);
    [name, rest] = [head[1], head[2].trim()];
  }
  const { mode, target, field, choices } = PRODUCE_ENTRIES[specialist][name];
  let chosen = choices?.[0];
  const stated = field ? new RegExp(`^${field}=(\\S+)\\s+([\\s\\S]+)$`).exec(rest) : null;
  if (stated) {
    if (!choices.includes(stated[1])) throw new CliError("usage_invalid", USAGE);
    [chosen, rest] = [stated[1], stated[2].trim()];
  }
  return { ask: rest, intent: { kind: "produce", specialist, mode, ...(target ? { target } : {}), ...(field ? { [field]: chosen } : {}) } };
}
