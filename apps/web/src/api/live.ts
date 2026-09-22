/**
 * The daemon's event stream, in the browser.
 *
 * `EventSource` rather than a websocket or a poll: the traffic is one-way, and
 * the browser reconnects on its own with no code of ours. The prototype polled
 * every two seconds, which was both slower to notice a change and busier when
 * nothing was happening.
 *
 * Subscribers get the event name; what they do about it is their business.
 * Most pages simply reload, which on a loopback socket costs nothing and cannot
 * drift from the daemon the way an incrementally patched client can.
 *
 * One socket for the whole page, however many subscribers. The board, the task
 * page and the project rail are all live at once, and three connections would
 * mean the same frame parsed three times and three reconnection backoffs
 * drifting apart after a daemon restart. `close()` therefore unsubscribes; the
 * socket itself goes when the last subscriber leaves.
 */
export interface LiveConnection {
  close(): void
}

const subscribers = new Set<(name: string) => void>()
let source: EventSource | undefined

function open(): void {
  source = new EventSource('/api/events')
  const forward = (event: MessageEvent): void => {
    try {
      const payload = JSON.parse(event.data as string) as { name?: string }
      if (typeof payload.name === 'string') {
        // Copied before iterating: a subscriber that unsubscribes in its own
        // handler would otherwise change the set underneath the loop.
        for (const subscriber of [...subscribers]) subscriber(payload.name)
      }
    } catch {
      // A malformed frame is not worth breaking the page over.
    }
  }
  // One listener, because the daemon sends every event as an ordinary
  // `message` frame. It used to name each frame after its event, which meant
  // this file carried its own list of names to listen for — 14 of the 23, as
  // it turned out, and an event missing from it was one the board silently
  // stopped updating for.
  source.addEventListener('message', forward)
}

export function live(onEvent: (name: string) => void): LiveConnection {
  // Guarded because the same stores are exercised in environments without one
  // (jsdom, a server render); the page still works, it just does not update
  // until something asks it to.
  if (typeof EventSource === 'undefined') return { close: () => {} }

  subscribers.add(onEvent)
  if (source === undefined) open()

  let closed = false
  return {
    close: () => {
      if (closed) return
      closed = true
      subscribers.delete(onEvent)
      if (subscribers.size === 0) {
        source?.close()
        source = undefined
      }
    },
  }
}
