export function resolveAdminPoolView(pools, currentPoolId, isCreating = false) {
  const selectedPool = currentPoolId
    ? pools.find(pool => pool.id === currentPoolId) || pools[0] || null
    : pools[0] || null;

  return { selectedPool, formPool: isCreating ? null : selectedPool };
}

export function createAdminPoolCreationFlow() {
  let active = false;
  let previousView = null;
  let saving = false;

  return {
    get active() { return active; },
    get saving() { return saving; },
    start(view) {
      if (!active) previousView = { poolId: view.poolId || null, tab: view.tab || "pool" };
      active = true;
      return { ...previousView };
    },
    cancel() {
      const restore = previousView ? { ...previousView } : null;
      active = false;
      previousView = null;
      saving = false;
      return restore;
    },
    complete() {
      active = false;
      previousView = null;
      saving = false;
    },
    async save(savePool, input) {
      if (saving) return { duplicate: true, pool: null };
      saving = true;
      try {
        return { duplicate: false, pool: await savePool(input) };
      } finally {
        saving = false;
      }
    }
  };
}
