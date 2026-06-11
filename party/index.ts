import type * as Party from "partykit/server";

export default class ChecklistParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection) {
    const saved = await this.room.storage.get<string>("state");
    if (saved) conn.send(saved);
  }

  async onMessage(message: string, sender: Party.Connection) {
    try {
      const incoming = JSON.parse(message) as { ts: number };
      const raw = await this.room.storage.get<string>("state");
      const current = raw ? (JSON.parse(raw) as { ts: number }) : null;
      if (!current || incoming.ts > current.ts) {
        await this.room.storage.put("state", message);
        this.room.broadcast(message, [sender.id]);
      }
    } catch {}
  }
}
