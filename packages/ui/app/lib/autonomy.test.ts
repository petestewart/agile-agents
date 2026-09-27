import { describe, expect, test } from 'bun:test';
import {
  AUTONOMY_LEVELS,
  COORDINATOR_AUTONOMY,
  autonomyOption,
  confirmsRun,
  inheritsOption,
  proposalCardWords,
  proposalChange,
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
  test('which change a summary holds, in the words since T446 and before', () => {
    expect(proposalChange('Add a part "Docs" on docs: a page')).toBe('add_child');
    expect(proposalChange('add child "Docs" on docs: a page')).toBe('add_child');
    expect(proposalChange('Make web wait on api')).toBe('add_waits_on');
    expect(proposalChange('Let api own prices.ts')).toBe('set_owner');
    expect(proposalChange('Approve a routine change to Key file: x')).toBe('approve_contract');
    expect(proposalChange('Create "Wishlist" in Shop with 2 parts: A, B')).toBe('create_tree');
    expect(proposalChange('Create "Docs" under Shop: g')).toBe('create_node');
    expect(proposalChange('Start api')).toBe('start_node');
    expect(proposalChange('something else')).toBe('other');
  });

  test('Advise: nothing changes until you apply; Apply creates the node and starts it', () => {
    const words = proposalCardWords({
      principal: 'coordinator',
      summary: 'Add a part "Document sale prices" on docs: a page',
      where: 'Shop',
      level: 'advise',
    });
    expect(`${words.where} ${words.level}${words.why} ${words.apply}`).toBe(
      'Shop is at Advise: nothing changes until you apply. Apply creates the node and starts it.',
    );
  });

  test('a contract change at Organise and Run; the Director; a new project', () => {
    const contract = 'Approve a change to Key file: x';
    expect(
      proposalCardWords({
        principal: 'coordinator',
        summary: contract,
        where: 'Blog',
        level: 'organise',
      }).why,
    ).toBe(': contract changes still come to you.');
    expect(
      proposalCardWords({ principal: 'coordinator', summary: contract, where: 'Ops', level: 'run' })
        .why,
    ).toBe(': only routine contract changes apply on their own.');
    const director = proposalCardWords({
      principal: 'director',
      summary: 'Start api',
      where: 'Shop',
      level: 'advise',
    });
    expect(`${director.where} ${director.level}${director.why} ${director.apply}`).toBe(
      'The Director’s level in Shop is Advise: nothing changes until you apply. Apply starts its agent.',
    );
    expect(
      proposalCardWords({
        principal: 'director',
        summary: 'Create the project Wishlist',
        where: undefined,
        level: undefined,
      }),
    ).toMatchObject({
      level: '',
      why: 'The Director asks first: a new project always comes to you.',
    });
  });
});
