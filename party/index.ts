import type * as Party from "partykit/server";

export default class ChecklistParty implements Party.Server {
  state: string | null = null;

  constructor(readonly room: Party.Room) {}

  async onStart() {
    this.state = (await this.room.storage.get<string>("state")) ?? null;
  }

  onConnect(conn: Party.Connection) {
    if (this.state) conn.send(this.state);
  }

  onMessage(message: string, sender: Party.Connection) {
    try {
      const incoming = JSON.parse(message) as { ts: number };
      const current = this.state ? (JSON.parse(this.state) as { ts: number }) : null;
      if (!current || incoming.ts > current.ts) {
        this.state = message;
        this.room.broadcast(message, [sender.id]);
        void this.room.storage.put("state", message);
      }
    } catch {}
  }
}
