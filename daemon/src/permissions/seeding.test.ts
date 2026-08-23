import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db/db.js';
import { Store } from '../db/store.js';
import { seedBuiltinRules, BUILTIN_RULES } from './rules.js';

/**
 * Seeding runs on every boot against databases of every age. The risk is asymmetric: seeding
 * too little leaves a new gate off on long-lived installs, seeding too much duplicates rules
 * or silently re-enables ones the user turned off.
 */
describe('seedBuiltinRules', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(openDb(':memory:'));
  });

  const key = (r: { kind: string; toolPattern: string; inputPattern: string }): string =>
    `${r.kind} ${r.toolPattern} ${r.inputPattern}`;

  it('seeds every builtin into an empty database', () => {
    seedBuiltinRules(store);
    expect(store.listRules()).toHaveLength(BUILTIN_RULES.length);
  });

  it('honours the enabled flag each rule ships with', () => {
    seedBuiltinRules(store);
    for (const spec of BUILTIN_RULES) {
      const got = store.listRules().find((r) => key(r) === key(spec));
      expect(got, `${spec.toolPattern} was not seeded`).toBeDefined();
      expect(got!.enabled, `${spec.toolPattern} enabled flag`).toBe(spec.enabled);
    }
  });

  it('is idempotent — repeated boots add nothing', () => {
    seedBuiltinRules(store);
    const after = store.listRules().length;
    seedBuiltinRules(store);
    seedBuiltinRules(store);
    expect(store.listRules()).toHaveLength(after);
  });

  it('adds a newly-introduced rule to a database that predates it', () => {
    // Simulate an older install: everything seeded except one gate.
    const [missing, ...rest] = BUILTIN_RULES;
    for (const r of rest) {
      const rule = store.createRule(r);
      if (!r.enabled) store.setRuleEnabled(rule.id, false);
    }
    expect(store.listRules().find((r) => key(r) === key(missing))).toBeUndefined();

    seedBuiltinRules(store);

    const added = store.listRules().find((r) => key(r) === key(missing));
    expect(added, 'a rule added in a later version must reach an existing database').toBeDefined();
    expect(added!.enabled).toBe(missing.enabled);
  });

  it('never re-enables a builtin the user has switched off', () => {
    seedBuiltinRules(store);
    const target = store.listRules().find((r) => r.builtin && r.enabled)!;
    store.setRuleEnabled(target.id, false);

    seedBuiltinRules(store);

    expect(store.getRule(target.id)?.enabled).toBe(false);
    expect(store.listRules().filter((r) => key(r) === key(target))).toHaveLength(1);
  });

  it('does not duplicate the one builtin that seeds as a user rule', () => {
    // send_to_bot ships with builtin:false, so a builtin-only comparison would re-add it.
    const spec = BUILTIN_RULES.find((r) => !r.builtin);
    expect(spec, 'expected at least one non-builtin seeded rule').toBeDefined();
    seedBuiltinRules(store);
    seedBuiltinRules(store);
    expect(store.listRules().filter((r) => key(r) === key(spec!))).toHaveLength(1);
  });
});
