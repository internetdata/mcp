import {
    ASN_LOOKUP_GATED_MEMBERS, ASN_LOOKUP_MEMBERS, DOMAIN_LOOKUP_GATED_MEMBERS, DOMAIN_LOOKUP_MEMBERS,
    LOOKUP_GATED_MEMBERS, LOOKUP_MEMBERS,
} from './schema.gen.js';

/**
 * What a lookup answer did and did not cover.
 *
 * The API's contract is that a missing member means "not in this plan", never
 * "we checked and found nothing". A model reading a served body cannot tell the
 * two apart and will report an absent `is_vpn` as a negative finding, so every
 * answer carries this alongside it.
 */
export interface Coverage {
    /** Members the API returned, so they were actually checked. */
    included: string[];
    /** Members this plan does not buy. Absent, not false. */
    not_included: string[];
    note: string;
}

/** Which lookup an answer came from: an address, an AS or a domain. */
export type LookupKind = 'ip' | 'asn' | 'domain';

interface KindMembers {
    members: readonly string[];
    gated: readonly string[];
    /** What was never checked, as the note names it. */
    subject: string;
    /** What a model must not conclude from an absent member. */
    misreading: string;
}

const KINDS: Record<LookupKind, KindMembers> = {
    ip: {
        members: LOOKUP_MEMBERS,
        gated: LOOKUP_GATED_MEMBERS,
        subject: 'the address',
        misreading: 'that the address is not a VPN, a proxy, hosting or a CDN, or that a detail of its '
            + 'location, network or abuse contact is unknown',
    },
    asn: {
        members: ASN_LOOKUP_MEMBERS,
        gated: ASN_LOOKUP_GATED_MEMBERS,
        subject: 'the AS',
        misreading: 'that the AS announces nothing or has no Whois record',
    },
    domain: {
        members: DOMAIN_LOOKUP_MEMBERS,
        gated: DOMAIN_LOOKUP_GATED_MEMBERS,
        subject: 'the domain',
        misreading: 'that the domain is not a disposable email domain or has no DNS records or IP ranges',
    },
};

const NOTE_FULL = 'This plan covers every dataset the API serves, so every field was checked. A '
    + 'false flag here is a real negative result.';

const NOTE_BOGON = 'This is a private, reserved or otherwise non-routable address. It was answered '
    + 'locally without calling the API, so every flag is false by definition rather than by lookup, '
    + 'and it did not count against the key\'s allowance.';

const NOTE_UNKNOWN = 'No served answer was available to derive coverage from, so this batch says '
    + 'nothing about which datasets the plan covers.';

const NOTE_MIXED = 'The answers in this batch do not all carry the same fields, and these lists are the '
    + 'narrowest answer\'s: one marked `cap_reached: true` or `trial_expired: true` has only Unlimited\'s '
    + 'fields, while the others have every field.';

/**
 * Derives coverage from the answer body alone.
 *
 * Deliberately no plan table: the members are read from the pinned spec and the
 * absent ones are whatever the API left out, so a field added to the API starts
 * appearing here as soon as `scripts/download-spec.sh` is re-run. The caller's
 * plan is never named, because the plan's identity is not the useful fact - what
 * it failed to check is.
 */
export function coverageOf(body: Record<string, unknown>, kind: LookupKind = 'ip'): Coverage {
    const { members, gated, subject, misreading } = KINDS[kind];
    const included = members.filter((m) => served(body, m));
    const notIncluded = gated.filter((m) => !served(body, m));
    let note = NOTE_FULL;
    if (notIncluded.length > 0) {
        let lead = 'The fields in not_included were not returned, because this API key\'s plan does not '
            + 'include them.';
        if (body['trial_expired'] === true) {
            lead = 'This key is on the free plan, and its organization\'s trial of every field is '
                + 'spent, so this answer is Unlimited\'s and the fields in not_included were '
                + 'not returned.';
        } else if (body['cap_reached'] === true) {
            lead = 'This key\'s organization has reached the overage cap it set on its paid plan, so this '
                + 'answer is Unlimited\'s, unbilled, and the fields in not_included were not returned. '
                + 'Raising or removing the cap in Billing brings them back.';
        }
        note = `${lead} Their absence is not a negative result: ${subject} was never checked against those `
            + 'datasets. Do not state or imply, on the basis of a field missing from this result, '
            + `${misreading}.`;
    }
    if (kind === 'ip' && body['is_bogon'] === true) {
        note = NOTE_BOGON;
    }
    return { included: included, not_included: notIncluded, note: note };
}

/**
 * One coverage for a whole batch, taken from its narrowest served answer.
 *
 * A bogon is answered locally in the widest shape, so reading coverage off one
 * would report every dataset as covered whatever the plan actually buys. Errors
 * carry no shape at all. With neither available there is nothing honest to say,
 * which is what `NOTE_UNKNOWN` says. Served answers can differ: an overage cap
 * reached part way through a batch answers the rest with Unlimited's fields, and
 * a free-plan key's daily trial can run out between its single lookups. Reading
 * the widest one would call every field checked, so the narrowest one speaks for
 * the batch and `NOTE_MIXED` says the answers differ.
 */
export function batchCoverage(bodies: Record<string, unknown>[]): Coverage {
    const answered = bodies.filter((b) => b['is_bogon'] !== true).map((b) => coverageOf(b));
    if (answered.length === 0) {
        return { included: [], not_included: [], note: NOTE_UNKNOWN };
    }
    const narrowest = answered.reduce((a, b) => (b.not_included.length > a.not_included.length ? b : a));
    if (answered.every((c) => c.not_included.length === narrowest.not_included.length)) {
        return narrowest;
    }
    return { ...narrowest, note: `${NOTE_MIXED} ${narrowest.note}` };
}

/** Whether an answer carries a member, `location.city` naming one inside `location`. */
function served(body: Record<string, unknown>, member: string): boolean {
    const [outer, inner] = member.split('.');
    if (!Object.hasOwn(body, outer)) {
        return false;
    }
    const value = body[outer];
    return inner === undefined
        || (value !== null && typeof value === 'object' && Object.hasOwn(value, inner));
}

export const COVERAGE_SCHEMA = {
    type: 'object',
    description: 'Which datasets this result covered. Read `note` before interpreting any absent field.',
    properties: {
        included: { type: 'array', items: { type: 'string' } },
        not_included: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
    },
    required: ['included', 'not_included', 'note'],
} as const;
