/**
 * Offices, terms, succession, and removal.
 *
 * §18. Elections previously computed a winner and stopped there, which meant an
 * elected role held nothing: the whole point of an office is that authority attaches
 * to it for a term and then stops.
 *
 * The design rule throughout: **an office does not hold capabilities, its holder
 * does.** Capabilities are granted to a DID when someone takes office and revoked
 * when they leave it, so §20's authorization path never needs to know offices exist.
 * An authorizer that had to resolve office membership would be a second place for
 * authority to live, and the two would eventually disagree.
 *
 * Spec: §18.
 */
import type { ConstitutionRule, ParticipantsState } from "@freeq-foundry/projections";
import type { ElectionMethod, TieBreak } from "./tally.js";

export interface OfficeDefinition {
  readonly officeId: string;
  readonly title: string;
  /** Namespaces granted to whoever holds it. */
  readonly capabilityNamespaces: readonly string[];
  /** Term length in logical time. */
  readonly termLogicalTime: number;
  readonly electionMethod: ElectionMethod;
  readonly tieBreaks: readonly TieBreak[];
  /**
   * Whether one participant may hold this office alongside others.
   *
   * §18.8 separation of duties: an office marked exclusive cannot be combined, so a
   * single agent cannot hold both the authority to propose a release and the
   * authority to approve it.
   */
  readonly exclusive?: boolean;
  /** Fraction of eligible voters, as an integer percent, required to remove (§18.6). */
  readonly removalThresholdPct?: number;
}

export interface OfficeTerm {
  readonly holderDid: string;
  readonly startedAtLogicalTime: number;
  readonly expiresAtLogicalTime: number;
  /** Grants issued on taking office, revoked on leaving it. */
  readonly grantIds: readonly string[];
  readonly endedAtLogicalTime?: number;
  readonly endReason?: OfficeEndReason;
}

export type OfficeEndReason = "term_expired" | "removed" | "resigned" | "suspended";

export interface OfficeState {
  readonly definition: OfficeDefinition;
  readonly current?: OfficeTerm;
  readonly history: readonly OfficeTerm[];
}

export type OfficeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string };

function fail<T>(code: string, reason: string): OfficeOutcome<T> {
  return { ok: false, code, reason };
}

function ok<T>(value: T): OfficeOutcome<T> {
  return { ok: true, value };
}

/** Effects the caller records as events. Kept pure so decisions are replayable. */
export type OfficeEffect =
  | {
      readonly kind: "assign_office";
      readonly officeId: string;
      readonly holderDid: string;
      readonly expiresAtLogicalTime: number;
      readonly grants: readonly {
        readonly grantId: string;
        readonly namespace: string;
        readonly expiresAtLogicalTime: number;
      }[];
    }
  | {
      readonly kind: "vacate_office";
      readonly officeId: string;
      readonly holderDid: string;
      readonly reason: OfficeEndReason;
      readonly revokeGrantIds: readonly string[];
    };

export interface OfficeRegistry {
  readonly byId: ReadonlyMap<string, OfficeState>;
}

export function emptyOfficeRegistry(): OfficeRegistry {
  return { byId: new Map() };
}

/** Offices a participant currently holds. */
export function officesHeldBy(
  registry: OfficeRegistry,
  did: string,
): readonly OfficeDefinition[] {
  return [...registry.byId.values()]
    .filter((office) => office.current?.holderDid === did)
    .map((office) => office.definition);
}

/**
 * Assign an office to a winner.
 *
 * Refuses rather than replaces an occupied office. A silent replacement would let a
 * second election quietly displace a sitting holder without the removal procedure
 * §18.6 requires, which is how a coup looks from the inside.
 */
export function takeOffice(
  registry: OfficeRegistry,
  participants: ParticipantsState,
  request: {
    readonly officeId: string;
    readonly holderDid: string;
    readonly atLogicalTime: number;
  },
): OfficeOutcome<OfficeEffect> {
  const office = registry.byId.get(request.officeId);
  if (office === undefined) {
    return fail("unknown_office", `office ${request.officeId} does not exist`);
  }

  const holder = participants.byDid.get(request.holderDid);
  if (holder === undefined) {
    return fail(
      "not_a_participant",
      `${request.holderDid} is not an admitted participant`,
    );
  }
  if (holder.suspended) {
    return fail("suspended", `${request.holderDid} is suspended and cannot take office`);
  }

  if (office.current !== undefined) {
    return fail(
      "office_occupied",
      `${request.officeId} is held by ${office.current.holderDid} until logical time ` +
        `${office.current.expiresAtLogicalTime}; use the removal procedure to vacate it`,
    );
  }

  // §18.8. Checked here rather than at authorization time, because the conflict is
  // about *holding* two offices, not about exercising either one.
  if (office.definition.exclusive === true) {
    const conflicting = officesHeldBy(registry, request.holderDid);
    if (conflicting.length > 0) {
      return fail(
        "separation_of_duties",
        `${request.officeId} is exclusive, and ${request.holderDid} already holds ` +
          `${conflicting.map((other) => other.officeId).join(", ")}`,
      );
    }
  }

  const expiresAtLogicalTime = request.atLogicalTime + office.definition.termLogicalTime;

  return ok({
    kind: "assign_office",
    officeId: request.officeId,
    holderDid: request.holderDid,
    expiresAtLogicalTime,
    // Grants expire with the term. A grant that outlived its office would leave
    // authority behind after the term ended, which is the failure this whole module
    // exists to prevent.
    grants: office.definition.capabilityNamespaces.map((namespace, index) => ({
      grantId: `${request.officeId}-${request.atLogicalTime}-${index}`,
      namespace,
      expiresAtLogicalTime,
    })),
  });
}

/**
 * Remove a holder by vote (§18.6).
 *
 * Requires the office's own threshold, which may be higher than an ordinary
 * proposal's. An office removable by simple majority is not much of an office.
 */
export function removeFromOffice(
  registry: OfficeRegistry,
  request: {
    readonly officeId: string;
    readonly votesFor: number;
    readonly eligibleVoters: number;
    readonly atLogicalTime: number;
  },
): OfficeOutcome<OfficeEffect> {
  const office = registry.byId.get(request.officeId);
  if (office === undefined) {
    return fail("unknown_office", `office ${request.officeId} does not exist`);
  }
  const current = office.current;
  if (current === undefined) {
    return fail("office_vacant", `${request.officeId} has no holder to remove`);
  }

  const threshold = office.definition.removalThresholdPct ?? 50;
  const share =
    request.eligibleVoters === 0
      ? 0
      : Math.round((request.votesFor / request.eligibleVoters) * 100);

  if (share <= threshold) {
    return fail(
      "threshold_not_met",
      `removal needs more than ${threshold}% of ${request.eligibleVoters} eligible voters; ` +
        `got ${request.votesFor} (${share}%)`,
    );
  }

  return ok({
    kind: "vacate_office",
    officeId: request.officeId,
    holderDid: current.holderDid,
    reason: "removed",
    revokeGrantIds: current.grantIds,
  });
}

/**
 * Offices whose term has expired.
 *
 * A term that quietly ran over would leave authority in place indefinitely, so
 * expiry is swept every tick rather than checked when someone happens to look.
 */
export function expiredOffices(
  registry: OfficeRegistry,
  atLogicalTime: number,
): readonly OfficeEffect[] {
  return [...registry.byId.values()]
    .filter(
      (office) =>
        office.current !== undefined &&
        office.current.expiresAtLogicalTime <= atLogicalTime,
    )
    .map((office) => {
      const current = office.current as OfficeTerm;
      return {
        kind: "vacate_office" as const,
        officeId: office.definition.officeId,
        holderDid: current.holderDid,
        reason: "term_expired" as const,
        revokeGrantIds: current.grantIds,
      };
    });
}

/**
 * Offices held by a participant who has since been suspended.
 *
 * §11.10 suspends descendants when a credential is revoked, and a suspended holder
 * must not keep the office's authority. Without this, revoking a root would strip a
 * participant's ability to act while leaving its office grants live.
 */
export function officesOfSuspended(
  registry: OfficeRegistry,
  participants: ParticipantsState,
): readonly OfficeEffect[] {
  return [...registry.byId.values()]
    .filter((office) => {
      const holder = office.current?.holderDid;
      if (holder === undefined) return false;
      return participants.byDid.get(holder)?.suspended === true;
    })
    .map((office) => {
      const current = office.current as OfficeTerm;
      return {
        kind: "vacate_office" as const,
        officeId: office.definition.officeId,
        holderDid: current.holderDid,
        reason: "suspended" as const,
        revokeGrantIds: current.grantIds,
      };
    });
}

/**
 * Whether an office may be filled without a fresh election.
 *
 * §18.7 acting authority: a vacancy is filled by election, not by appointment. This
 * only reports that a vacancy exists; nothing here can install a holder, deliberately.
 */
export function vacantOffices(registry: OfficeRegistry): readonly OfficeDefinition[] {
  return [...registry.byId.values()]
    .filter((office) => office.current === undefined)
    .map((office) => office.definition);
}

/** Offices a constitution defines, from `office_definition` rules. */
export function officeDefinitionsFrom(
  rules: readonly ConstitutionRule[],
): readonly string[] {
  return rules
    .filter((rule) => rule.kind === "capability_bound")
    .map((rule) => rule.id);
}
