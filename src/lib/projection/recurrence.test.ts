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

describe('expandRule: frecuencia diaria', () => {
  it('genera una ocurrencia por día dentro del rango, respetando inicio y fin', () => {
    const r = rule({ id: 'd', frequency: 'DAILY', startDate: '2026-11-28', endDate: '2026-12-02' });
    expect(expandRule(r, '2026-11-01', '2026-12-31')).toEqual(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(expandRule(r, '2026-11-30', '2026-12-01')).toEqual(['2026-11-30', '2026-12-01']);
  });

  it('una regla diaria de hace años sigue proyectando (salta directo al rango)', () => {
    const r = rule({ id: 'd', frequency: 'DAILY', startDate: '2020-01-01' });
    const out = expandRule(r, '2026-11-20', '2026-12-19');
    expect(out).toHaveLength(30);
    expect(out[0]).toBe('2026-11-20');
    expect(out[29]).toBe('2026-12-19');
  });

  it('semanal y quincenal con salto conservan su día de la semana', () => {
    // 2026-01-05 es lunes
    const w = expandRule(rule({ id: 'w', frequency: 'WEEKLY', startDate: '2026-01-05' }), '2026-11-18', '2026-12-01');
    expect(w).toEqual(['2026-11-23', '2026-11-30']);
    const b = expandRule(rule({ id: 'b', frequency: 'BIWEEKLY', startDate: '2026-01-05' }), '2026-11-18', '2026-12-31');
    expect(b).toEqual(['2026-11-23', '2026-12-07', '2026-12-21']);
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
