import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getHostMemory, hostMemorySchema, mergeHostMemory, rememberHosts, type HostMemory } from "../shared/hosts";
import { telemetryDirectory } from "./telemetry";

/**
 * When each connected host was last seen online and which version of this plugin it ran, so the 主机 panel can say how long
 * an offline host has been away and whether it still needs the current version. Labels, server IDs, versions and times only.
 */
export class HostMemoryStore {
  private hosts: HostMemory[] = [];
  private writes: Promise<void> = Promise.resolve();
  private loaded: Promise<void>;
  constructor(private directory = telemetryDirectory()) {
    this.loaded = readFile(join(directory, "host-memory.json"), "utf8").then(text => {
      const parsed = hostMemorySchema.safeParse(JSON.parse(text));
      if (parsed.success) this.hosts = parsed.data.hosts;
    }).catch(() => {});
  }
  async get(): Promise<{ hosts: HostMemory[] }> {
    await this.loaded;
    return { hosts: this.hosts.map(entry => ({ ...entry })) };
  }
  async remember(seen: readonly HostMemory[]): Promise<{ hosts: HostMemory[] }> {
    await this.loaded;
    const next = mergeHostMemory(this.hosts, seen);
    if (JSON.stringify(next) !== JSON.stringify(this.hosts)) {
      this.hosts = next;
      this.writes = this.writes.then(() => this.save(), () => this.save());
      await this.writes.catch(() => {});
    }
    return this.get();
  }
  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    const file = join(this.directory, "host-memory.json"), temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, hosts: this.hosts }), { mode: 0o600 });
    await rename(temporary, file);
  }
}

export function registerHostMemory(server: PluginServerContext, store = new HostMemoryStore()) {
  server.handle(getHostMemory, () => store.get());
  server.handle(rememberHosts, input => store.remember(input.hosts));
  // Paseo owns RPC registration teardown; handle() does not return an unregister callback.
  return () => {};
}
