import { describe, expect, it } from 'vitest';
import { expandRule, occurrenceKey, pendingOccurrences } from './recurrence';
import type { EngineRule } from './types';

function rule(p: Partial<EngineRule> & { id: string }): EngineRule {
  return {
    entityId: 'A',
    direction: 'OUT',
    description: p.id,
    amount: 1000_00,
    frequency: 'MONTHLY',
    startDate: '2026-11-01',
    endDate: null,
    priority: 'FIXED',
    active: true,
    ...p,
  };
}

describe('expandRule', () => {
  it('mensual conserva el día ancla (31 -> fin de mes)', () => {
    expect(expandRule(rule({ id: 'r', startDate: '2027-01-31' }), '2027-01-01', '2027-04-30')).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
  });

  it('respeta fecha final y reglas inactivas', () => {
    expect(expandRule(rule({ id: 'r', endDate: '2026-12-15' }), '2026-11-01', '2027-03-01')).toEqual(['2026-11-01', '2026-12-01']);
    expect(expandRule(rule({ id: 'r', active: false }), '2026-11-01', '2027-03-01')).toEqual([]);
  });
});

describe('pendingOccurrences', () => {
  const mensual = rule({ id: 'alquiler', description: 'Alquiler', startDate: '2026-10-05' });
  const quincenal = rule({ id: 'planilla', description: 'Planilla', frequency: 'BIWEEKLY', startDate: '2026-11-13' });

  it('lista ocurrencias del rango ordenadas por fecha', () => {
    const r = pendingOccurrences([mensual, quincenal], new Set(), '2026-11-14', '2026-12-31');
    expect(r.map((o) => `${o.rule.id}:${o.date}`)).toEqual([
      'planilla:2026-11-27',
      'alquiler:2026-12-05',
      'planilla:2026-12-11',
      'planilla:2026-12-25',
    ]);
  });

  it('omite las ocurrencias ya materializadas', () => {
    const done = new Set([occurrenceKey('alquiler', '2026-12-05'), occurrenceKey('planilla', '2026-12-11')]);
    const r = pendingOccurrences([mensual, quincenal], done, '2026-11-14', '2026-12-31');
    expect(r.map((o) => `${o.rule.id}:${o.date}`)).toEqual(['planilla:2026-11-27', 'planilla:2026-12-25']);
  });

  it('no incluye ocurrencias anteriores al inicio del rango', () => {
    const r = pendingOccurrences([mensual], new Set(), '2026-11-14', '2026-11-30');
    expect(r).toEqual([]);
  });

  it('a igual fecha ordena por descripción', () => {
    const a = rule({ id: 'b', description: 'Zeta', startDate: '2026-12-01' });
    const b = rule({ id: 'a', description: 'Agua', startDate: '2026-12-01' });
    const r = pendingOccurrences([a, b], new Set(), '2026-12-01', '2026-12-01');
    expect(r.map((o) => o.rule.description)).toEqual(['Agua', 'Zeta']);
  });
});
