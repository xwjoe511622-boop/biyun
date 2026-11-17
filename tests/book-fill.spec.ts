import { describe, expect, it } from 'vitest'
import {
  bookSuggestion,
  capContracts,
  cumulativeThrough,
  spotFillAmount,
  takerSide,
  type BookRows,
  type PriceSuggestion,
} from '@/modules/trade/book-fill'

describe('book-fill', () => {
  describe('takerSide', () => {
    it('maps ask -> BUY and bid -> SELL', () => {
      expect(takerSide('ask')).toBe('BUY')
      expect(takerSide('bid')).toBe('SELL')
    })
  })

  describe('cumulativeThrough', () => {
    const rows = [{ amount: '1.5' }, { amount: '2' }, { amount: '0.25' }]

    it('sums through the given index inclusively', () => {
      expect(cumulativeThrough(rows, 0)).toBe('1.5')
      expect(cumulativeThrough(rows, 2)).toBe('3.75')
    })

    it('returns empty for out-of-range indices', () => {
      expect(cumulativeThrough(rows, 3)).toBe('')
      expect(cumulativeThrough(rows, -1)).toBe('')
    })

    it('returns empty when any summed amount is not a decimal string', () => {
      expect(cumulativeThrough([{ amount: '1.5' }, { amount: 'x' }, { amount: '0.25' }], 2)).toBe('')
    })
  })

  describe('bookSuggestion', () => {
    it('produces a bare price/sequence suggestion without a pick', () => {
      expect(bookSuggestion(undefined, '100')).toEqual({ price: '100', sequence: 1 })
    })

    it('continues the sequence and attaches side + cumulative amount for an ask pick', () => {
      const previous: PriceSuggestion = { price: '99', sequence: 4 }
      const pick = { book: 'ask', index: 1 } as const
      const rows: BookRows = { asks: [{ amount: '1' }, { amount: '2' }], bids: [] }
      expect(bookSuggestion(previous, '100', pick, rows)).toEqual({
        price: '100',
        sequence: 5,
        side: 'BUY',
        amount: '3',
      })
    })

    it('attaches side SELL for a bid pick', () => {
      const pick = { book: 'bid', index: 1 } as const
      const rows: BookRows = { asks: [], bids: [{ amount: '1' }, { amount: '2' }] }
      expect(bookSuggestion(undefined, '100', pick, rows)).toEqual({
        price: '100',
        sequence: 1,
        side: 'SELL',
        amount: '3',
      })
    })
  })

  describe('spotFillAmount', () => {
    it('floors a BUY base amount to the step', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'base',
          baseQty: '0.123456',
          price: '100',
          available: '1000',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('0.123')
    })

    it('caps a BUY by the quote balance', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'base',
          baseQty: '1',
          price: '100',
          available: '5',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('0.05')
    })

    it('caps a SELL by the base balance', () => {
      expect(
        spotFillAmount({
          side: 'SELL',
          unit: 'base',
          baseQty: '1',
          price: '100',
          available: '0.2',
          step: '0.01',
          quotePrecision: 2,
        }),
      ).toBe('0.2')
    })

    it('converts a quote-unit BUY without a balance cap', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'quote',
          baseQty: '0.5',
          price: '100',
          available: '',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('50')
    })

    it('returns empty when the available balance is zero', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'base',
          baseQty: '1',
          price: '100',
          available: '0',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('')
    })

    it('returns empty when the price is not positive', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'base',
          baseQty: '1',
          price: '0',
          available: '',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('')
    })

    it('returns empty when the base quantity rounds below the step', () => {
      expect(
        spotFillAmount({
          side: 'BUY',
          unit: 'base',
          baseQty: '0.0004',
          price: '100',
          available: '',
          step: '0.001',
          quotePrecision: 2,
        }),
      ).toBe('')
    })
  })

  describe('capContracts', () => {
    it('floors the cumulative to whole contracts', () => {
      expect(capContracts('12.9', '')).toBe('12')
    })

    it('caps at the whole max', () => {
      expect(capContracts('12', '5')).toBe('5')
      expect(capContracts('12', '7.8')).toBe('7')
    })

    it('returns empty when the result is not positive', () => {
      expect(capContracts('0.4', '')).toBe('')
      expect(capContracts('12', '0')).toBe('')
    })

    it('returns empty for an invalid cumulative', () => {
      expect(capContracts('abc', '5')).toBe('')
    })
  })
})
