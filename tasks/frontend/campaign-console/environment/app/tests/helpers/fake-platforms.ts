// A PlatformAdapter whose answers a test scripts, recording every call.
import type { PlatformAdapter } from "../../src/server/platforms/types.ts";
import type { Credential, Platform, RunItem } from "../../src/shared/types.ts";

export interface FakeAdapter extends PlatformAdapter {
  probes: Credential[];
  sends: { credential: Credential; item: RunItem }[];
  refreshes: Credential[];
}

export interface FakeBehaviour {
  probe?: (credential: Credential) => Promise<void>;
  send?: (credential: Credential, item: RunItem) => Promise<{ externalId: string }>;
  refresh?: (credential: Credential) => Promise<Credential>;
}

export function fakeAdapter(platform: Platform, behaviour: FakeBehaviour = {}): FakeAdapter {
  const adapter: FakeAdapter = {
    platform,
    probes: [],
    sends: [],
    refreshes: [],
    async probe(credential) {
      adapter.probes.push(credential);
      await behaviour.probe?.(credential);
    },
    async send(credential, item) {
      adapter.sends.push({ credential, item });
      return behaviour.send ? behaviour.send(credential, item) : { externalId: `${platform}-${item.id}` };
    },
  };
  if (behaviour.refresh) {
    const refresh = behaviour.refresh;
    adapter.refresh = async (credential) => {
      adapter.refreshes.push(credential);
      return refresh(credential);
    };
  }
  return adapter;
}
