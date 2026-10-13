import { describe, expect, test } from 'bun:test';
import {
  AUTONOMY_LEVELS,
  COORDINATOR_AUTONOMY,
  autonomyOption,
  confirmsRun,
  inheritsOption,
  proposalCardWords,
  runConfirm,
} from './autonomy';
import { DIRECTOR_AUTONOMY } from './director';

describe('autonomy in words (T423)', () => {
  test('every level reads capitalised, with a few words and a sentence, for both', () => {
    for (const words of [COORDINATOR_AUTONOMY, DIRECTOR_AUTONOMY]) {
      for (const level of AUTONOMY_LEVELS) {
        expect(words[level].label).toMatch(/^[A-Z]/);
        expect(words[level].short).toMatch(/^[a-z]/);
        expect(words[level].hint).toMatch(/\.$/);
      }
    }
  });

  test('options: "Advise — proposes, you apply"; the Director reads as its own panel', () => {
    expect(autonomyOption('coordinator', 'advise')).toBe('Advise — proposes, you apply');
    expect(autonomyOption('director', 'organise')).toBe('Organise — creates and starts');
    expect(inheritsOption('advise')).toBe('Inherits Advise from the project');
  });

  test('only a change up to Run asks first', () => {
    expect(confirmsRun('advise', 'run')).toBe(true);
    expect(confirmsRun('organise', 'run')).toBe(true);
    expect(confirmsRun('run', 'run')).toBe(false);
    expect(confirmsRun('run', 'advise')).toBe(false);
    expect(confirmsRun('advise', 'organise')).toBe(false);
    expect(runConfirm('director', 'Shop').title).toBe('Let the Director run Shop on its own?');
    expect(runConfirm('coordinator', 'Shop').confirm).toBe('Set to Run');
  });
});

describe('T446: a held proposal’s card names its level and what Apply does', () => {
  test('T514: what Apply does comes from the change itself, not its summary’s words', () => {
    const apply = (change: Parameters<typeof proposalCardWords>[0]['change']) =>
      proposalCardWords({ principal: 'coordinator', change, where: 'Shop', level: 'advise' }).apply;
    expect(apply('add_child')).toBe('Apply creates the node and starts it.');
    expect(apply('add_waits_on')).toBe('Apply makes it wait.');
    expect(apply('set_owner')).toBe('Apply gives it those paths.');
    expect(apply('approve_contract')).toBe('Apply approves the change and tells the parts.');
    expect(apply('create_tree')).toBe('Apply creates the node and its parts and starts them.');
    expect(apply('create_node')).toBe('Apply creates the node and starts it.');
    expect(apply('restart_node')).toBe('Apply restarts its agent.');
    // A change with no words of its own yet, or none named.
    expect(apply('reorder')).toBe('Apply makes the change.');
    expect(apply(undefined)).toBe('Apply makes the change.');
  });

  test('Advise: nothing changes until you apply; Apply creates the node and starts it', () => {
    const words = proposalCardWords({
      principal: 'coordinator',
      change: 'add_child',
      where: 'Shop',
      level: 'advise',
    });
    expect(`${words.where} ${words.level}${words.why} ${words.apply}`).toBe(
      'Shop is at Advise: nothing changes until you apply. Apply creates the node and starts it.',
    );
  });

  test('a contract change at Organise and Run; the Director; a new project', () => {
    const contract = 'approve_contract';
    expect(
      proposalCardWords({
        principal: 'coordinator',
        change: contract,
        where: 'Blog',
        level: 'organise',
      }).why,
    ).toBe(': contract changes still come to you.');
    expect(
      proposalCardWords({ principal: 'coordinator', change: contract, where: 'Ops', level: 'run' })
        .why,
    ).toBe(': only routine contract changes apply on their own.');
    const director = proposalCardWords({
      principal: 'director',
      change: 'start_node',
      where: 'Shop',
      level: 'advise',
    });
    expect(`${director.where} ${director.level}${director.why} ${director.apply}`).toBe(
      'The Director’s level in Shop is Advise: nothing changes until you apply. Apply starts its agent.',
    );
    expect(
      proposalCardWords({
        principal: 'director',
        change: 'create_project',
        where: undefined,
        level: undefined,
      }),
    ).toMatchObject({
      level: '',
      why: 'The Director asks first: a new project always comes to you.',
    });
  });
});
