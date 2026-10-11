import { addDays, businessDate, businessHour } from '../../shared/utils/business-time.js';
import { notifyUsers } from '../../shared/notifications/push.js';
import * as userDirectoryRepository from '../user-directory/user-directory.repository.js';
import * as ownerInsights from '../dashboard/owner-insights.service.js';
import * as repository from './owner-digest.repository.js';

// A digest is only worth sending as a morning briefing. If the app was down at the configured
// hour it is still sent when it comes back, but not late in the evening about "yesterday".
const LATEST_SEND_HOUR = 21;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function rupiah(value) {
  return `Rp ${Math.round(Number(value)).toLocaleString('id-ID')}`;
}

function dateLabel(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// Pure: turns one day's branch-comparison + cash-variance numbers into the notification text.
// Only parts that carry information are included, so a quiet day stays short.
export function formatDigest({ date, branches, cash }) {
  const { totals, branches: rows } = branches;
  const sentences = [];

  if (totals.sales_count === 0) {
    sentences.push('Tidak ada penjualan.');
  } else {
    let sales = `Penjualan ${rupiah(totals.sales_total)} (${totals.sales_count} transaksi`;
    if (totals.sales_growth_pct != null && totals.sales_growth_pct !== 0) {
      sales += `, ${totals.sales_growth_pct > 0 ? 'naik' : 'turun'} ${Math.abs(totals.sales_growth_pct)}% dari hari sebelumnya`;
    }
    sentences.push(`${sales}).`);
    if (Number(totals.revenue) > 0) sentences.push(`Margin ${totals.gross_margin_pct}%.`);

    const sellingBranches = rows.filter((row) => Number(row.sales_total) > 0);
    if (sellingBranches.length >= 2) sentences.push(`Terbaik: ${sellingBranches[0].name}.`);
  }

  const summary = cash.summary;
  if (summary.sessions_with_variance > 0) {
    const parts = [];
    if (Number(summary.total_shortage) > 0) parts.push(`kurang ${rupiah(summary.total_shortage)}`);
    if (Number(summary.total_overage) > 0) parts.push(`lebih ${rupiah(summary.total_overage)}`);
    sentences.push(`Kas: ${summary.sessions_with_variance} sesi berselisih (${parts.join(', ')}).`);
  } else if (summary.sessions_closed > 0) {
    sentences.push('Kas: semua sesi cocok.');
  }
  if (summary.overdue_open_count > 0) {
    sentences.push(`${summary.overdue_open_count} sesi kasir belum ditutup lebih dari 24 jam.`);
  }

  const stock = [];
  if (totals.out_of_stock_count > 0) stock.push(`${totals.out_of_stock_count} habis`);
  if (totals.low_stock_count > 0) stock.push(`${totals.low_stock_count} menipis`);
  if (stock.length > 0) sentences.push(`Stok: ${stock.join(', ')}.`);

  return {
    title: `Ringkasan ${dateLabel(date)}`,
    body: sentences.join(' '),
    data: { type: 'owner_digest', date }
  };
}

// Builds the digest for one owner: everything is scoped to that owner's own business units, so one
// company's numbers never reach another company's owner. Returns null when the owner has no
// warehouse in scope (nothing to report).
export async function buildDigest(db, { buIds, date }) {
  const period = { from: date, to: date };
  const [branches, cash] = await Promise.all([
    ownerInsights.getBranchComparison(db, period, buIds, null),
    ownerInsights.getCashVariance(db, period, buIds, null)
  ]);
  if (branches.data.branches.length === 0) return null;
  return formatDigest({ date, branches: branches.data, cash: cash.data });
}

// One scheduler tick. Safe to call as often as you like: a day is claimed per owner with an atomic
// insert, so restarts, catch-ups and parallel instances never double-send. `now` is injectable for
// tests. Returns how many digests were sent.
export async function runOwnerDigest(db, { now = new Date(), sendHour = 7, log = console } = {}) {
  const hour = businessHour(now);
  if (hour < sendHour || hour >= LATEST_SEND_HOUR) return 0;

  const date = addDays(businessDate(now), -1); // the day being summarised: yesterday (WIB)
  const owners = await userDirectoryRepository.findUsersByRole(db, 'owner');
  let sent = 0;

  for (const owner of owners) {
    // buIds null would mean "unrestricted" and is never an owner's real scope; an owner without a
    // BU list (or with an empty one) has nothing to report. Skipping must not consume the claim.
    if (!Array.isArray(owner.bu_ids) || owner.bu_ids.length === 0) continue;

    if (!(await repository.claim(db, owner.user_id, date))) continue; // already sent (or in flight)

    try {
      const digest = await buildDigest(db, { buIds: owner.bu_ids.map(Number), date });
      if (!digest) continue; // claim kept: no warehouses means no digest today, and none tomorrow either
      await notifyUsers(db, { userIds: [owner.user_id], ...digest });
      sent += 1;
    } catch (error) {
      log.warn?.({ err: error.message, userId: owner.user_id, date }, 'owner digest failed, will retry');
      await repository.release(db, owner.user_id, date).catch(() => {});
    }
  }
  return sent;
}
