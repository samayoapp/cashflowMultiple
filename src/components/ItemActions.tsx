'use client';

import { useState } from 'react';
import { CalendarClock, CheckCircle2, Coins, CreditCard } from 'lucide-react';
import type { ProjectedItem } from '@/lib/projection/types';
import type { ObligationDto } from '@/lib/server/dto';
import { api, emitDataChanged } from '@/lib/client/api';
import { Button, useToast } from './ui';
import { PaymentModal, RescheduleModal } from './forms';
import { CardPaymentModal, type CardPaymentTarget } from './cards';

/**
 * Acciones rápidas sobre una partida proyectada (pagar, abonar, reprogramar).
 * Si es una ocurrencia virtual de una recurrencia, primero se materializa.
 */
export function useItemActions() {
  const toast = useToast();
  const [payTarget, setPayTarget] = useState<ObligationDto | null>(null);
  const [payFull, setPayFull] = useState(false);
  const [moveTarget, setMoveTarget] = useState<ObligationDto | null>(null);
  const [cardTarget, setCardTarget] = useState<CardPaymentTarget | null>(null);

  async function ensureObligation(item: ProjectedItem): Promise<ObligationDto | null> {
    try {
      if (item.obligationId) return await api<ObligationDto>(`/api/obligations/${item.obligationId}`);
      return await api<ObligationDto>(`/api/recurrences/${item.ruleId}/materialize`, { body: { date: item.date } });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
      return null;
    }
  }

  async function pay(item: ProjectedItem, full: boolean) {
    if (item.source === 'CARD_STATEMENT' && item.cardAccountId) {
      setCardTarget({ cardId: item.cardAccountId, entityId: item.entityId, suggested: full ? item.amountNative : undefined });
      return;
    }
    if (item.transferId) {
      toast('Las transferencias se ejecutan desde CxC / CxP → Transferencias', 'error');
      return;
    }
    if (item.isHypothetical) {
      toast('Una partida hipotética no recibe pagos reales', 'error');
      return;
    }
    const ob = await ensureObligation(item);
    if (!ob) return;
    if (!item.obligationId) emitDataChanged();
    setPayFull(full);
    setPayTarget(ob);
  }

  async function reschedule(item: ProjectedItem) {
    if (item.source === 'CARD_STATEMENT') {
      toast('La fecha de un pago de tarjeta la define su ciclo de corte (Operaciones → Tarjetas)', 'error');
      return;
    }
    const ob = await ensureObligation(item);
    if (!ob) return;
    if (!item.obligationId) emitDataChanged();
    setMoveTarget(ob);
  }

  const modals = (
    <>
      <PaymentModal open={Boolean(payTarget)} onClose={() => setPayTarget(null)} target={payTarget} full={payFull} />
      <RescheduleModal open={Boolean(moveTarget)} onClose={() => setMoveTarget(null)} target={moveTarget} />
      <CardPaymentModal open={Boolean(cardTarget)} onClose={() => setCardTarget(null)} target={cardTarget} />
    </>
  );

  return { pay, reschedule, modals };
}

export function ItemActionButtons({
  item,
  actions,
}: {
  item: ProjectedItem;
  actions: ReturnType<typeof useItemActions>;
}) {
  if (item.source === 'CARD_STATEMENT') {
    return (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" title="Pagar tarjeta" onClick={() => actions.pay(item, true)}>
          <CreditCard className="h-4 w-4 text-emerald-600" />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" title={item.direction === 'IN' ? 'Marcar cobrado' : 'Marcar pagado'} onClick={() => actions.pay(item, true)}>
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      </Button>
      <Button size="sm" variant="ghost" title="Abono parcial" onClick={() => actions.pay(item, false)}>
        <Coins className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" title="Reprogramar" onClick={() => actions.reschedule(item)}>
        <CalendarClock className="h-4 w-4" />
      </Button>
    </div>
  );
}
