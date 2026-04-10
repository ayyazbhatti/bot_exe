import { useMemo, useState } from 'react'
import { useRemoteHistoryWebSocket, type RemoteHistoryAccountRow, type RemoteDealRow } from '../useRemoteHistoryWebSocket'

function entryLabel(entry: number | null | undefined): string {
  if (entry === null || entry === undefined) return ''
  const e = Math.trunc(entry)
  const m: Record<number, string> = { 0: 'in', 1: 'out', 2: 'inout', 3: 'out_by' }
  return m[e] ?? String(e)
}

function formatDealTime(ts: number): string {
  if (!ts || ts <= 0) return ''
  try {
    return new Date(ts * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

function netPnl(d: RemoteDealRow): number {
  return (d.profit ?? 0) + (d.swap ?? 0) + (d.commission ?? 0)
}

type FlatRow =
  | {
      kind: 'deal'
      key: string
      deviceLabel: string
      accountLabel: string
      time: string
      symbol: string
      type: string
      entry: string
      volume: string
      price: string
      net: number
      deal: string
      position: string
      note: string
    }
  | {
      kind: 'err'
      key: string
      deviceLabel: string
      accountLabel: string
      message: string
    }

export default function RemoteHistory() {
  const { rows, lastUpdate, connected } = useRemoteHistoryWebSocket()
  const [deviceId, setDeviceId] = useState<string>('__all__')

  const devices = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) {
      if (!m.has(r.device_id)) m.set(r.device_id, r.device_label)
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  const filtered = useMemo(() => {
    if (deviceId === '__all__') return rows
    return rows.filter((r) => r.device_id === deviceId)
  }, [rows, deviceId])

  const flatRows = useMemo(() => {
    const out: FlatRow[] = []
    const accountRows: RemoteHistoryAccountRow[] = [...filtered].sort((a, b) => {
      const da = a.device_label.localeCompare(b.device_label)
      if (da !== 0) return da
      return a.label.localeCompare(b.label)
    })
    for (const acct of accountRows) {
      if (acct.bridge_error) {
        out.push({
          kind: 'err',
          key: `${acct.device_id}|${acct.account_id}|err`,
          deviceLabel: acct.device_label,
          accountLabel: acct.label,
          message: acct.bridge_error,
        })
        continue
      }
      const deals = [...acct.deals].sort((a, b) => b.time - a.time || b.ticket - a.ticket)
      for (const d of deals) {
        const net = netPnl(d)
        out.push({
          kind: 'deal',
          key: `${acct.device_id}|${acct.account_id}|${d.ticket}`,
          deviceLabel: acct.device_label,
          accountLabel: acct.label,
          time: formatDealTime(d.time),
          symbol: d.symbol,
          type: d.type,
          entry: entryLabel(d.entry),
          volume: String(d.volume),
          price: String(d.price),
          net,
          deal: String(d.ticket),
          position: d.position_id ? String(d.position_id) : '',
          note: (d.comment ?? '').slice(0, 160),
        })
      }
    }
    return out
  }, [filtered])

  const totals = useMemo(() => {
    let n = 0
    let sum = 0
    for (const r of flatRows) {
      if (r.kind === 'deal') {
        n++
        sum += r.net
      }
    }
    return { n, sum }
  }, [flatRows])

  return (
    <div className="card live-positions-card">
      <div className="live-page-header">
        <div>
          <h2 className="live-page-title">Remote deal history</h2>
          <p className="muted" style={{ marginTop: '0.35rem', maxWidth: 720 }}>
            Closed buy/sell deals from MT5 on paired desktop agents (same window and refresh interval as the agent’s
            Position history tab). Updates when agents push <code>history_deals_snapshot</code> to the panel.
          </p>
          <div className="live-positions-accounts-surface remote-form-surface" style={{ marginTop: '1rem' }}>
            <div className="remote-form-group">
              <div className="form-row remote-form-field">
                <label htmlFor="remote-history-device">Device</label>
                <select
                  id="remote-history-device"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                >
                  <option value="__all__">All devices</option>
                  {devices.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <p className="muted" style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>
            Stream:{' '}
            <span className={connected ? 'profit' : 'loss'}>{connected ? 'connected' : 'reconnecting…'}</span>
            {lastUpdate && (
              <>
                {' '}
                · Last update: {lastUpdate.toLocaleTimeString()}
              </>
            )}
            {' · '}
            Rows: {totals.n} deal{totals.n === 1 ? '' : 's'}
            {totals.n > 0 && (
              <>
                {' '}
                · Net (sum):{' '}
                <span className={totals.sum >= 0 ? 'profit' : 'loss'}>
                  {(totals.sum >= 0 ? '+' : '') + totals.sum.toFixed(2)}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {flatRows.length === 0 ? (
        <p className="empty" style={{ padding: '1rem 0' }}>
          No history yet. Ensure agents are online and have MT5 paths configured; history refreshes on the agent every
          few tens of seconds.
        </p>
      ) : (
        <div className="dashboard-table-wrap" style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Account</th>
                <th>Time</th>
                <th>Symbol</th>
                <th>Type</th>
                <th>Entry</th>
                <th>Vol</th>
                <th>Price</th>
                <th>Net</th>
                <th>Deal</th>
                <th>Pos</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map((r) =>
                r.kind === 'err' ? (
                  <tr key={r.key} className="remote-history-error-row">
                    <td colSpan={12} style={{ color: 'var(--danger, #f87171)' }}>
                      <strong>
                        {r.deviceLabel} · {r.accountLabel}
                      </strong>
                      : {r.message}
                    </td>
                  </tr>
                ) : (
                  <tr key={r.key}>
                    <td>{r.deviceLabel}</td>
                    <td>{r.accountLabel}</td>
                    <td>{r.time}</td>
                    <td>{r.symbol}</td>
                    <td>
                      <span className={r.type}>{r.type}</span>
                    </td>
                    <td>{r.entry}</td>
                    <td>{r.volume}</td>
                    <td>{r.price}</td>
                    <td className={r.net >= 0 ? 'profit' : 'loss'}>
                      {(r.net >= 0 ? '+' : '') + r.net.toFixed(2)}
                    </td>
                    <td>{r.deal}</td>
                    <td>{r.position}</td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
