// Bid values and secrets of the participation screens (design.md 8·12·17번).
// They live only in this browser's storage, never on the server, in the DB or in Git, and a bid's
// entry is written BEFORE its transaction is sent: if the page or the browser dies right after a
// successful send, the secret is still there and the bid can be revealed.

const PREFIX = "blind-auction:bid:";

/**
 * Same key as the scripts' file name (.bids/<chainId>-<contract>-<auctionId>-<bidder>.json, design.md 12번).
 * @param {{ chainId: number, contract: string, auctionId: bigint | string, bidder: string }} k
 * @returns {string}
 */
export function bidKey(k) {
  return `${k.chainId}-${k.contract.toLowerCase()}-${k.auctionId}-${k.bidder.toLowerCase()}`;
}

/**
 * @typedef {{ chainId: number, contract: string, auctionId: string, bidder: string, value: string,
 *             secret: string, deposit: string, commitment: string, createdAt: string }} SavedBid
 *   Same fields as the scripts' secret file. Amounts are wei strings.
 * @typedef {Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">} StorageLike
 */

export class SecretStore {
  /** @param {StorageLike} storage localStorage in the browser, an in-memory stand-in in tests */
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Writes the bid and reads it back. Throws when the browser did not keep it (storage full,
   * blocked site data), so the caller never sends a bid whose secret is not saved.
   * @param {SavedBid} bid
   * @returns {string} the key
   */
  save(bid) {
    const key = bidKey(bid);
    const text = JSON.stringify(bid);
    try {
      this.storage.setItem(PREFIX + key, text);
    } catch (err) {
      throw new Error(`브라우저 저장소에 secret을 저장하지 못해서 입찰을 보내지 않았습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.storage.getItem(PREFIX + key) !== text) {
      throw new Error("브라우저 저장소에 secret을 저장하지 못해서 입찰을 보내지 않았습니다");
    }
    return key;
  }

  /** @param {string} key */
  has(key) {
    return this.storage.getItem(PREFIX + key) !== null;
  }

  /**
   * The saved bid, or null when there is none. Throws when the entry is not readable JSON.
   * @param {string} key
   * @returns {SavedBid | null}
   */
  load(key) {
    const text = this.storage.getItem(PREFIX + key);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`브라우저 저장소의 secret이 손상되었습니다 (JSON이 아님). 저장 키: ${key}`);
    }
  }

  /** @returns {SavedBid[]} every bid saved in this browser, newest first */
  list() {
    /** @type {SavedBid[]} */
    const bids = [];
    for (let i = 0; i < this.storage.length; i++) {
      const name = this.storage.key(i);
      if (!name?.startsWith(PREFIX)) continue;
      try {
        const bid = this.load(name.slice(PREFIX.length));
        if (bid) bids.push(bid);
      } catch {
        // a damaged entry: left in storage as it is, not listed
      }
    }
    return bids.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** All saved bids as JSON, for the backup download. */
  exportJson() {
    return JSON.stringify(this.list(), null, 2) + "\n";
  }
}

/**
 * The browser's localStorage, or null when the browser does not allow it (then no bid can be placed).
 * @returns {SecretStore | null}
 */
export function browserStore() {
  try {
    const probe = `${PREFIX}probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return new SecretStore(localStorage);
  } catch {
    return null;
  }
}
