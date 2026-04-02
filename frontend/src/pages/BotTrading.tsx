type Account = { id: string; label: string }

type Props = {
  accounts: Account[]
  accountId: string
  setAccountId: (id: string) => void
  symbols: string[]
  connectionError: string | null
  onRetrySymbols: () => void
  fetchSymbols: () => void
  msg: { type: 'success' | 'error'; text: string } | null
  symbol: string
  setSymbol: (s: string) => void
  orderType: 'buy' | 'sell'
  setOrderType: (t: 'buy' | 'sell') => void
  volume: number
  setVolume: (v: number) => void
  stopLoss: string
  setStopLoss: (s: string) => void
  takeProfit: string
  setTakeProfit: (s: string) => void
  comment: string
  setComment: (s: string) => void
  placeOnBoth: boolean
  setPlaceOnBoth: (b: boolean) => void
  placeMasterSlaveHedge: boolean
  setPlaceMasterSlaveHedge: (b: boolean) => void
  submitting: boolean
  onSubmit: (e: React.FormEvent) => void
  workerMinVolume: number
  workerMaxVolume: number
}

export default function BotTrading(props: Props) {
  const {
    accounts,
    accountId,
    setAccountId,
    symbols,
    connectionError,
    onRetrySymbols,
    fetchSymbols,
    msg,
    symbol,
    setSymbol,
    orderType,
    setOrderType,
    volume,
    setVolume,
    stopLoss,
    setStopLoss,
    takeProfit,
    setTakeProfit,
    comment,
    setComment,
    placeOnBoth,
    setPlaceOnBoth,
    placeMasterSlaveHedge,
    setPlaceMasterSlaveHedge,
    submitting,
    onSubmit,
    workerMinVolume,
    workerMaxVolume,
  } = props

  return (
    <>
      {accounts.length > 0 && (
        <div className="card trading-card">
          <div className="trading-card-header">
            <h2>Trading terminal</h2>
            <span className="trading-badge">{accounts.length} account{accounts.length === 1 ? '' : 's'}</span>
          </div>
          <div className="trading-form-grid one-col">
            <div>
              <label>Account (MT5 terminal)</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {connectionError && (
        <div className="card trading-card">
          <div className="trading-card-header">
            <h2>Connection issue</h2>
            <span className="trading-badge subtle">API</span>
          </div>
          <div className="msg error">{connectionError}</div>
          <button type="button" onClick={onRetrySymbols} style={{ marginTop: '0.5rem' }}>
            Retry
          </button>
        </div>
      )}

      {symbols.length === 0 && !connectionError && (
        <div className="card trading-card">
          <div className="trading-card-header">
            <h2>Symbols</h2>
            <span className="trading-badge subtle">Not loaded</span>
          </div>
          <div className="msg error">No symbols loaded. Start MetaTrader 5, log in, then refresh.</div>
          <button type="button" onClick={fetchSymbols} style={{ marginTop: '0.5rem' }}>Load symbols</button>
        </div>
      )}

      <div className="card trading-card">
        <div className="trading-card-header">
          <h2>Open position</h2>
          <span className="trading-badge subtle">Manual order</span>
        </div>
        <div className="trading-subheader">
          <span className="trading-mini-chip">Fast order entry</span>
          <span className="trading-mini-chip">Selected terminal</span>
        </div>
        <form onSubmit={onSubmit}>
          <div className="trading-section-divider" />
          <div className="trading-form-grid">
            <div>
              <label>Symbol</label>
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} required>
                <option value="">Select symbol</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div>
              <label>Direction{placeMasterSlaveHedge ? ' (Broker B opposite, Exness same)' : ''}</label>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as 'buy' | 'sell')}>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </div>
          </div>

          <div className="trading-section-divider" />
          <div className="trading-form-grid">
            <div>
              <label>Volume (lots){placeOnBoth ? ' — used for this order' : placeMasterSlaveHedge ? ' — on Broker B (Exness opens volume ÷ N)' : ''}</label>
              <input
                type="number"
                step="0.0001"
                min="0.0001"
                value={volume}
                onChange={(e) => setVolume(Math.max(0.0001, Number(e.target.value) || 0.0001))}
                title={placeMasterSlaveHedge ? 'Broker B full size; Exness opens (volume ÷ N) where N is set in Exness copy hedge.' : placeOnBoth ? 'Volume for this manual order. Server-side worker (if enabled) uses random lots from saved worker config.' : ''}
              />
            </div>
          </div>
          {placeMasterSlaveHedge && (
            <p className="settings-hint" style={{ marginTop: 0 }}>Broker B opens this volume. Exness opens (volume ÷ N) lots, where N is set in Exness copy hedge.</p>
          )}
          {placeOnBoth && (
            <p className="settings-hint" style={{ marginTop: 0 }}>This order uses the volume above. If the server-side worker is enabled, it uses random between {workerMinVolume} and {workerMaxVolume} lots (from saved config / API).</p>
          )}

          <div className="trading-section-divider" />
          <div className="trading-form-grid">
            <div>
              <label>Stop loss (optional)</label>
              <input
                type="number"
                step="any"
                placeholder="0"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
              />
            </div>
            <div>
              <label>Take profit (optional)</label>
              <input
                type="number"
                step="any"
                placeholder="0"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
              />
            </div>
          </div>

          <div className="trading-section-divider" />
          <label>Comment (optional)</label>
          <input
            type="text"
            placeholder="Comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />

          <label className="trading-toggle">
            <input
              type="checkbox"
              checked={placeOnBoth}
              onChange={(e) => {
                const v = e.target.checked
                setPlaceOnBoth(v)
                if (v) setPlaceMasterSlaveHedge(false)
              }}
            />
            Place on both accounts (one Buy, one Sell — assigned randomly)
          </label>
          <label className="trading-toggle">
            <input
              type="checkbox"
              checked={placeMasterSlaveHedge}
              onChange={(e) => {
                const v = e.target.checked
                setPlaceMasterSlaveHedge(v)
                if (v) setPlaceOnBoth(false)
              }}
            />
            Place hedge (Broker B full size, Exness volume ÷ N)
          </label>

          {msg && <div className={`msg ${msg.type}`}>{msg.text}</div>}

          <div className="trading-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Placing…' : 'Place order'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
