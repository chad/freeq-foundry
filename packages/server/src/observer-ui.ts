/**
 * The observer UI.
 *
 * §38.1's goal is that an observer can explain a deployment from human root to result.
 * The acceptance criterion for this screen is the same: every consequential event
 * should be traceable to who acted, under what authority, from which lineage.
 *
 * A single self-contained page with no build step and no framework. The observer must
 * still work when opened from a published dataset years later, and a toolchain is the
 * part most likely to have rotted.
 *
 * §59.17: prefer a legible failure to an opaque success. Denials, failed proposals,
 * and rejected releases are shown as prominently as successes.
 */
export const OBSERVER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Freeq Foundry — observer</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #e6edf3;
    --dim: #8b949e; --accent: #58a6ff; --good: #3fb950; --bad: #f85149;
    --warn: #d29922; --gov: #bc8cff; --code: #39c5cf;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    padding: 10px 16px; border-bottom: 1px solid var(--line);
    display: flex; gap: 20px; align-items: baseline; flex-wrap: wrap;
    position: sticky; top: 0; background: var(--bg); z-index: 10;
  }
  h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  .status { color: var(--dim); }
  .status b { color: var(--text); font-weight: 600; }
  .chain-ok { color: var(--good); } .chain-bad { color: var(--bad); }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 0; height: calc(100vh - 46px); }
  #feed { overflow-y: auto; padding: 8px 0; }
  aside { border-left: 1px solid var(--line); overflow-y: auto; padding: 12px 16px; }
  .ev {
    display: grid; grid-template-columns: 48px 130px 1fr; gap: 10px;
    padding: 3px 16px; border-left: 3px solid transparent; cursor: pointer;
  }
  .ev:hover { background: var(--panel); }
  .ev.sel { background: var(--panel); border-left-color: var(--accent); }
  .lt { color: var(--dim); text-align: right; }
  .ty { color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .su { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cat-governance .ty, .cat-election .ty { color: var(--gov); }
  .cat-capability .ty { color: var(--warn); }
  .cat-repository .ty, .cat-ci .ty { color: var(--code); }
  .cat-evaluation .ty { color: var(--good); }
  .bad .ty, .bad .su { color: var(--bad); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--dim); margin: 18px 0 6px; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  td:first-child { color: var(--dim); padding-right: 10px; white-space: nowrap; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 4px;
        padding: 8px; overflow-x: auto; font-size: 11px; margin: 4px 0 0;
        white-space: pre-wrap; word-break: break-all; }
  .did { color: var(--code); }
  .pill { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 11px;
          border: 1px solid var(--line); color: var(--dim); }
  .pill.on { border-color: var(--good); color: var(--good); }
  .pill.off { border-color: var(--bad); color: var(--bad); }
  input { background: var(--panel); border: 1px solid var(--line); color: var(--text);
          padding: 3px 8px; border-radius: 4px; font: inherit; width: 160px; }
  .empty { color: var(--dim); padding: 24px 16px; }
</style>
</head>
<body>
<header>
  <h1>FREEQ FOUNDRY</h1>
  <span class="status">run <b id="run">—</b></span>
  <span class="status">events <b id="count">0</b></span>
  <span class="status">chain <b id="chain" class="chain-ok">—</b></span>
  <span class="status">outcome <b id="outcome">—</b></span>
  <span class="status">grants <b id="grants">0</b></span>
  <span class="status">denials <b id="denials">0</b></span>
  <input id="filter" placeholder="filter events…" />
</header>
<main>
  <div id="feed"><div class="empty">waiting for events…</div></div>
  <aside id="side"><h2>select an event</h2>
    <p style="color:var(--dim)">Every event traces to an actor, a human root, and the
    capability that authorized it. Click one to see its full provenance.</p>
  </aside>
</main>
<script>
const feed = document.getElementById("feed");
const side = document.getElementById("side");
const filterInput = document.getElementById("filter");
const events = [];
let selected = null;
let filter = "";

const state = { grants: 0, denials: 0, outcome: "running", participants: new Map() };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const shortDid = (d) => typeof d === "string" && d.length > 20
  ? d.slice(0, 12) + "…" + d.slice(-4) : String(d ?? "—");
const cat = (t) => String(t).split(".")[0];

// One-line summaries. The feed must be readable at a glance, and a raw payload dump
// is not; the detail panel is where the whole event lives.
function summarize(e) {
  const p = e.payload ?? {};
  switch (e.eventType) {
    case "controller.run_started": return "scenario " + p.scenarioId + ", horizon " + Math.round((p.horizonMs||0)/3600000) + "h";
    case "controller.run_terminated": return "reason: " + p.reason;
    case "admission.participant_admitted": return shortDid(p.did) + " admitted, lineage " + p.lineagePseudonym + " depth " + p.lineageDepth;
    case "admission.participant_rejected": return shortDid(p.did) + " REFUSED — " + p.reason;
    case "admission.participant_suspended": return shortDid(p.did) + " suspended (" + p.reasonCode + ")";
    case "provenance.credential_issued": return shortDid(p.subjectDid) + " chain of " + (p.credentialIds||[]).length;
    case "provenance.credential_revoked": return p.credentialId + " revoked, affects " + (p.affectedParticipantDids||[]).length;
    case "governance.constitution_adopted": return "version " + p.version + ", " + (p.rules||[]).length + " rules";
    case "governance.proposal_opened": return '"' + p.title + '" closes at ' + p.closesAtLogicalTime;
    case "governance.vote_cast": return p.proposalId + " ← " + (p.choice||{}).type;
    case "governance.proposal_closed": return p.proposalId + " " + String(p.outcome).toUpperCase() + " — " + p.reason;
    case "governance.proposal_executed": return p.proposalId + " applied " + p.appliedActions + " effect(s)";
    case "capability.granted": return p.namespace + " → " + shortDid(p.toDid);
    case "capability.attenuated": return p.namespace + " → " + shortDid(p.toDid) + " (attenuated)";
    case "capability.revoked": return p.grantId + " revoked";
    case "capability.action_denied": return "DENIED " + p.attemptedNamespace + " — " + p.reason;
    case "capability.authorization_decided": return (p.allowed ? "allow " : "deny ") + p.namespace;
    case "treasury.budget_allocated": return p.credits + " credits → " + shortDid(p.toDid);
    case "treasury.spend_recorded": return p.credits + " credits" + (p.usd ? " / $" + p.usd : "") + " (" + p.purpose + ")";
    case "treasury.budget_exhausted": return p.reason || "budget exhausted";
    case "communication.message_posted": return "#" + p.channelId + ": " + p.text;
    case "work.item_opened": return p.workItemId + (p.description ? " — " + p.description : "");
    case "work.item_claimed": return p.workItemId;
    case "work.item_completed": return p.workItemId + " done";
    case "repository.branch_created": return p.branch + " from " + p.fromBranch;
    case "repository.commit_created": return p.branch + " ← " + (p.paths||[]).join(", ") +
      (p.agentAuthored === false ? " [scenario-supplied]" : " [agent-authored]");
    case "repository.pull_request_opened": return p.pullRequestId + " " + p.sourceBranch + " → " + p.targetBranch;
    case "repository.pull_request_reviewed": return p.pullRequestId + " " + p.verdict;
    case "repository.pull_request_merged": return p.pullRequestId + " merged into " + p.targetBranch;
    case "ci.completed": return p.branch + " " + p.outcome;
    case "model.invoked": return p.provider + ":" + p.snapshotIdentifier + " " +
      (p.status === "failed" ? "FAILED " + p.failureKind : (p.inputTokens||0) + "→" + (p.outputTokens||0) + " tok") +
      " [level " + p.verificationLevel + "]";
    case "evaluation.release_submitted": return p.releaseId;
    case "evaluation.release_verified": return "VERIFIED " + p.mandatoryTestsPassed + "/" + p.mandatoryTestsTotal + " criteria";
    case "evaluation.release_rejected": return "rejected " + p.mandatoryTestsPassed + "/" + p.mandatoryTestsTotal +
      " — failed: " + (p.failures||[]).join(", ");
    case "safety.event": return "[" + p.severity + "] " + p.description;
    default: return JSON.stringify(p).slice(0, 120);
  }
}

const isBad = (e) =>
  e.eventType === "capability.action_denied" ||
  e.eventType === "admission.participant_rejected" ||
  e.eventType === "evaluation.release_rejected" ||
  e.eventType === "safety.event" ||
  e.eventType === "treasury.budget_exhausted" ||
  (e.eventType === "governance.proposal_closed" && e.payload?.outcome === "failed") ||
  (e.eventType === "ci.completed" && e.payload?.outcome !== "succeeded") ||
  (e.eventType === "model.invoked" && e.payload?.status === "failed");

function track(e) {
  const p = e.payload ?? {};
  if (e.eventType === "capability.granted" || e.eventType === "capability.attenuated") state.grants++;
  if (e.eventType === "capability.action_denied") state.denials++;
  if (e.eventType === "admission.participant_admitted") state.participants.set(p.did, p);
  if (e.eventType === "evaluation.release_verified") state.outcome = "SHIPPED";
  if (e.eventType === "controller.run_terminated" && state.outcome === "running") state.outcome = p.reason;
  document.getElementById("count").textContent = events.length;
  document.getElementById("grants").textContent = state.grants;
  document.getElementById("denials").textContent = state.denials;
  const out = document.getElementById("outcome");
  out.textContent = state.outcome;
  out.className = state.outcome === "SHIPPED" ? "chain-ok" : state.outcome === "running" ? "" : "chain-bad";
  if (e.runId) document.getElementById("run").textContent = e.runId;
}

function row(e, index) {
  const div = document.createElement("div");
  div.className = "ev cat-" + cat(e.eventType) + (isBad(e) ? " bad" : "");
  div.dataset.index = String(index);
  div.innerHTML =
    '<span class="lt">' + e.logicalTime + '</span>' +
    '<span class="ty">' + esc(e.eventType.split(".").slice(1).join(".") || e.eventType) + '</span>' +
    '<span class="su">' + esc(summarize(e)) + '</span>';
  div.onclick = () => select(index);
  return div;
}

function matches(e) {
  if (filter === "") return true;
  const haystack = (e.eventType + " " + summarize(e) + " " + e.actorDid).toLowerCase();
  return haystack.includes(filter);
}

function render() {
  feed.textContent = "";
  const visible = events.filter(matches);
  if (visible.length === 0) {
    feed.innerHTML = '<div class="empty">no events match</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.appendChild(row(e, events.indexOf(e)));
  feed.appendChild(frag);
}

// The §38.1 acceptance criterion, on screen: actor, lineage, and the authority relied
// upon, for any event.
function select(index) {
  selected = index;
  for (const el of feed.querySelectorAll(".ev")) el.classList.toggle("sel", el.dataset.index === String(index));
  const e = events[index];
  if (!e) return;
  const pr = e.provenance ?? {};
  const rows = (pairs) => pairs.map(([k, v]) => "<tr><td>" + k + "</td><td>" + v + "</td></tr>").join("");

  side.innerHTML =
    "<h2>" + esc(e.eventType) + "</h2>" +
    "<table>" + rows([
      ["logical time", e.logicalTime],
      ["wall time", esc(e.wallTime)],
      ["actor", '<span class="did">' + esc(e.actorDid) + "</span>"],
      ["type", esc(e.participantType)],
      ["sequence", e.participantSequence],
      ["visibility", esc((e.visibility || {}).type)],
    ]) + "</table>" +
    "<h2>provenance</h2>" +
    "<table>" + rows([
      ["signer", '<span class="did">' + shortDid(pr.signerDid) + "</span>"],
      ["human root", (pr.terminalHumanDids || []).map(shortDid).join(", ") || "—"],
      ["admission", esc(pr.admissionCredentialId || "—")],
      ["capabilities used", (pr.capabilityGrantIds || []).join(", ") || "none"],
      ["governance basis", (pr.governanceAuthorizationIds || []).join(", ") || "none"],
      ["instructed by", (pr.directInstructionEventIds || []).join(", ") || "not instructed"],
      ["chain depth", (pr.provenancePathHashes || []).length],
    ]) + "</table>" +
    "<h2>integrity</h2>" +
    "<table>" + rows([
      ["event hash", "<code>" + esc(String(e.eventHash).slice(0, 26)) + "…</code>"],
      ["previous", "<code>" + esc(String(e.previousEventHash).slice(0, 26)) + "…</code>"],
      ["participant sig", "<code>" + esc(String(e.signature).slice(0, 20)) + "…</code>"],
      ["recorder sig", "<code>" + esc(String(e.recorderSignature).slice(0, 20)) + "…</code>"],
    ]) + "</table>" +
    "<h2>payload</h2><pre>" + esc(JSON.stringify(e.payload, null, 2)) + "</pre>";
}

filterInput.oninput = () => { filter = filterInput.value.trim().toLowerCase(); render(); };

const params = new URLSearchParams(location.search);
const source = new EventSource("/api/stream?" + params.toString());
let atBottom = true;
feed.onscroll = () => { atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40; };

source.addEventListener("append", (message) => {
  const e = JSON.parse(message.data);
  events.push(e);
  track(e);
  if (matches(e)) {
    if (feed.querySelector(".empty")) feed.textContent = "";
    feed.appendChild(row(e, events.length - 1));
    // Follows the tail unless the observer has scrolled up to read something.
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }
});

source.addEventListener("caughtup", async () => {
  try {
    const verification = await (await fetch("/api/verify")).json();
    const el = document.getElementById("chain");
    el.textContent = verification.valid ? "verified" : verification.violations.length + " violations";
    el.className = verification.valid ? "chain-ok" : "chain-bad";
  } catch { /* the run may have ended and closed the store */ }
});

source.onerror = () => {
  const el = document.getElementById("chain");
  if (el.textContent === "—") el.textContent = "disconnected";
};
</script>
</body>
</html>`;
