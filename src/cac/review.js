/**
 * Radiologist review of a CAC analysis.
 *
 * The algorithm result is kept untouched in `review.algorithm`; every change goes
 * to the working lesion list and is written to `review.audit`. Approval freezes
 * the review and produces the only score the report may use.
 *
 * All functions are pure: they take a review and return a new one.
 */
import { regionGrow } from './agatston'
import { ENGINE_VERSION, VESSELS, cacCategory, rescore, toLesion, vesselTotals } from './pipeline'

const r1 = (n) => Math.round(n * 10) / 10

export function createReview(result, user) {
  return {
    status: 'in-review',
    algorithm: {
      engineVersion: result.engineVersion,
      kind: result.kind,
      at: result.at,
      runBy: user,
      totals: result.totals,
      lesions: result.lesions.map(({ voxels, ...rest }) => rest), // snapshot without voxel payload
      validation: result.validation,
    },
    lesions: result.lesions,
    excluded: result.excluded,
    removed: [],
    seq: 0,
    audit: [
      {
        at: result.at,
        user,
        action: 'Algorithm analysis',
        detail: `${result.kind === 'standard' ? 'Standard' : 'Opportunistic'} analysis · ${result.lesions.length} lesions · total ${r1(result.totals.total)}`,
        delta: 0,
      },
    ],
    approved: null,
  }
}

export const currentTotals = (review) => vesselTotals(review.lesions)

/** Lesions still needing a decision before the score can be approved. */
export function blockers(review) {
  const pending = review.lesions.filter((l) => l.status !== 'accepted')
  const unassigned = review.lesions.filter((l) => !VESSELS.includes(l.vessel))
  return { pending, unassigned, ok: !pending.length && !unassigned.length }
}

const describe = (l) => `${l.id}${l.vessel ? ` (${l.vessel})` : ''}`

/**
 * Apply one radiologist operation. `ctx` = { vol, user, at? }.
 * Throws on an operation that is not allowed (e.g. editing an approved review).
 */
export function applyOp(review, op, ctx) {
  if (review.status === 'approved') throw new Error('Approved CAC results are locked')
  const at = ctx.at || new Date().toISOString()
  const before = currentTotals(review).total
  const log = (next, action, detail, lesion) => {
    const after = currentTotals(next).total
    return { ...next, audit: [...next.audit, { at, user: ctx.user, action, detail, lesion: lesion || null, delta: after - before }] }
  }
  const find = (id) => review.lesions.find((l) => l.id === id)
  const replace = (id, fn) => review.lesions.map((l) => (l.id === id ? fn(l) : l))

  switch (op.type) {
    case 'accept': {
      const l = find(op.id)
      return log({ ...review, lesions: replace(op.id, (x) => ({ ...x, status: 'accepted' })) }, 'Accepted lesion', describe(l), op.id)
    }
    case 'accept-all': {
      const n = review.lesions.filter((l) => l.status !== 'accepted').length
      return log({ ...review, lesions: review.lesions.map((l) => ({ ...l, status: 'accepted' })) }, 'Accepted all lesions', `${n} lesion${n === 1 ? '' : 's'}`)
    }
    case 'delete': {
      const l = find(op.id)
      return log(
        { ...review, lesions: review.lesions.filter((x) => x.id !== op.id), removed: [...review.removed, { ...l, reason: op.reason || 'False positive' }] },
        'Deleted lesion',
        `${describe(l)} · ${op.reason || 'False positive'} · −${r1(l.score)}`,
        op.id
      )
    }
    case 'vessel': {
      const l = find(op.id)
      if (!VESSELS.includes(op.vessel)) throw new Error(`Unknown vessel ${op.vessel}`)
      return log(
        { ...review, lesions: replace(op.id, (x) => ({ ...x, vessel: op.vessel, status: 'accepted' })) },
        'Changed vessel',
        `${l.id}: ${l.vessel || 'unassigned'} → ${op.vessel}`,
        op.id
      )
    }
    case 'restore': {
      const x = review.excluded.find((e) => e.id === op.id)
      const seq = review.seq + 1
      const lesion = { ...x, id: `R${seq}`, source: 'restored', status: op.vessel ? 'accepted' : 'pending', vessel: op.vessel || null, reason: undefined }
      return log(
        { ...review, seq, excluded: review.excluded.filter((e) => e.id !== op.id), lesions: [...review.lesions, lesion] },
        'Restored excluded candidate',
        `${x.id} (was: ${x.reason}) → ${lesion.id}${op.vessel ? ` (${op.vessel})` : ''} · +${r1(x.score)}`,
        lesion.id
      )
    }
    case 'add': {
      const voxels = regionGrow(ctx.vol, op.seed)
      if (!voxels.length) throw new Error('No calcium (≥130 HU) at that point')
      const overlap = review.lesions.find((l) => l.voxels.includes(op.seed))
      if (overlap) throw new Error(`That calcium already belongs to ${overlap.id}`)
      const seq = review.seq + 1
      const base = toLesion({ regions: [], voxels: [] }, `M${seq}`, 'manual')
      const lesion = { ...rescore(ctx.vol, base, voxels), vessel: op.vessel || null, status: op.vessel ? 'accepted' : 'pending' }
      if (!lesion.score) throw new Error('Region is under the 1 mm² minimum area')
      return log({ ...review, seq, lesions: [...review.lesions, lesion] }, 'Added missed lesion', `${lesion.id}${op.vessel ? ` (${op.vessel})` : ''} · +${r1(lesion.score)}`, lesion.id)
    }
    case 'erase': {
      const l = find(op.id)
      const drop = new Set(op.voxels)
      const kept = l.voxels.filter((v) => !drop.has(v))
      if (kept.length === l.voxels.length) return review
      const next = rescore(ctx.vol, l, kept)
      const lesions = next.score > 0 ? replace(op.id, () => ({ ...next, status: 'accepted' })) : review.lesions.filter((x) => x.id !== op.id)
      return log({ ...review, lesions }, 'Edited lesion boundary', `${describe(l)}: ${r1(l.score)} → ${r1(next.score)}`, op.id)
    }
    case 'recalculate': {
      const lesions = review.lesions.map((l) => rescore(ctx.vol, l, l.voxels))
      return log({ ...review, lesions }, 'Recalculated', `${lesions.length} lesions re-scored from voxels`)
    }
    case 'approve': {
      const b = blockers(review)
      if (!b.ok) throw new Error('Every lesion must be accepted and assigned to a vessel before approval')
      const totals = currentTotals(review)
      const approved = {
        totals,
        category: cacCategory(totals.total),
        lesionCount: review.lesions.length,
        algorithmTotal: review.algorithm.totals.total,
        delta: totals.total - review.algorithm.totals.total,
        kind: review.algorithm.kind,
        approvedBy: ctx.user,
        approvedAt: at,
        engineVersion: review.algorithm.engineVersion || ENGINE_VERSION,
        lesions: review.lesions.map(({ voxels, regions, ...rest }) => rest),
      }
      return {
        ...review,
        status: 'approved',
        approved,
        audit: [...review.audit, { at, user: ctx.user, action: 'Approved final score', detail: `${Math.round(totals.total)} (${approved.category.code})`, delta: 0 }],
      }
    }
    default:
      throw new Error(`Unknown review operation ${op.type}`)
  }
}

/** Report text for an approved result. Never produced from an unapproved review. */
export function reportText(approved) {
  const t = approved.totals
  const s = (n) => Math.round(n)
  const lines = [
    `Coronary artery calcium (Agatston${approved.kind === 'opportunistic' ? ', opportunistic estimate from a non-standard series' : ''}): total ${s(t.total)} — LM ${s(t.LM)}, LAD ${s(t.LAD)}, LCX ${s(t.LCX)}, RCA ${s(t.RCA)}.`,
    `${approved.category.code} (${approved.category.label.toLowerCase()}).`,
  ]
  if (approved.kind === 'opportunistic') lines.push('This value is not a standard Agatston score and should not be compared directly with dedicated CAC studies.')
  return lines.join(' ')
}
