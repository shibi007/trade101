/**
 * Tests for position sizing.
 *
 * The function lives inline in public/index.html (the client is a single file
 * with no build step), so it is duplicated here rather than imported. It is
 * short and stable; the alternative is leaving the arithmetic that sizes real
 * orders completely untested.
 *
 * Keep in sync with `positionSize` in public/index.html.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const RISK_PCT = 0.02;

function positionSize(price, riskPerShare, capital, lev) {
  if (!(price > 0) || !(riskPerShare > 0) || !(capital > 0)) return null;
  const riskBudget = capital * RISK_PCT;
  const buyingPower = capital * lev;
  const byRisk = Math.floor(riskBudget / riskPerShare);
  const byMargin = Math.floor(buyingPower / price);
  const qty = Math.max(0, Math.min(byRisk, byMargin));
  return {
    qty, byRisk, byMargin,
    boundBy: byMargin < byRisk ? 'margin' : 'risk',
    notional: qty * price,
    riskAtStop: qty * riskPerShare,
    riskBudget, buyingPower,
    actualRiskPct: capital > 0 ? (qty * riskPerShare) / capital * 100 : 0,
  };
}

const CAPITAL = 322433;   // the account from the reported case

test('a position never exceeds buying power', () => {
  // The original formula divided the risk budget by risk-per-share with no
  // upper bound, so a quiet stock produced ₹34 lakh of stock against ₹12.9L of
  // buying power.
  const s = positionSize(800, 1.5, CAPITAL, 4);
  assert.ok(s.notional <= s.buyingPower, `₹${s.notional} exceeds ₹${s.buyingPower}`);
  assert.equal(s.boundBy, 'margin');
});

test('risk binds when the stop is wide', () => {
  // TCS at ₹2404 with a ₹42 stop: 2% of capital allows 153 shares, well inside
  // buying power, so risk is the binding constraint.
  const s = positionSize(2404.3, 42, CAPITAL, 4);
  assert.equal(s.boundBy, 'risk');
  assert.equal(s.qty, 153);
  assert.ok(s.riskAtStop <= s.riskBudget);
});

test('risk at the stop never exceeds the risk budget', () => {
  for (const [price, risk] of [[100, 2], [500, 2.5], [1168, 12], [2404, 42], [12400, 90]]) {
    for (const lev of [1, 2, 4, 5]) {
      const s = positionSize(price, risk, CAPITAL, lev);
      assert.ok(s.riskAtStop <= s.riskBudget + 1e-9,
        `₹${price}/risk ₹${risk}/${lev}x risks ₹${s.riskAtStop} of a ₹${s.riskBudget} budget`);
    }
  }
});

test('capping by margin reduces risk rather than raising it', () => {
  // The safe direction to be wrong in: a margin-capped trade risks under 2%.
  const s = positionSize(800, 1.5, CAPITAL, 4);
  assert.ok(s.actualRiskPct < 2, `capped trade still risks ${s.actualRiskPct}%`);
});

test('leverage raises the cap but never the risk', () => {
  const cash = positionSize(800, 1.5, CAPITAL, 1);
  const margin = positionSize(800, 1.5, CAPITAL, 4);
  assert.ok(margin.qty > cash.qty, 'more buying power should allow more stock');
  assert.ok(margin.riskAtStop <= margin.riskBudget, 'but never more than the risk budget');
  assert.ok(cash.riskAtStop <= cash.riskBudget);
});

test('1x leverage keeps the position inside cash', () => {
  const s = positionSize(500, 2.5, CAPITAL, 1);
  assert.ok(s.notional <= CAPITAL, `₹${s.notional} exceeds ₹${CAPITAL} of cash`);
});

test('an unaffordable stock yields zero shares, not a fraction', () => {
  // A share priced above total buying power cannot be bought at all.
  const s = positionSize(500000, 1000, CAPITAL, 1);
  assert.equal(s.qty, 0);
  assert.equal(s.notional, 0);
});

test('quantities are whole shares', () => {
  for (const [price, risk, lev] of [[137, 3.7, 4], [999, 13.3, 2], [45.5, 1.1, 5]]) {
    const s = positionSize(price, risk, CAPITAL, lev);
    assert.equal(s.qty, Math.floor(s.qty), 'cannot buy part of a share');
  }
});

test('unusable inputs return null rather than a bogus size', () => {
  // This is the guard that stopped a null ATR becoming 644,865 shares.
  assert.equal(positionSize(100, 0, CAPITAL, 4), null, 'zero risk would divide by zero');
  assert.equal(positionSize(100, null, CAPITAL, 4), null);
  assert.equal(positionSize(0, 5, CAPITAL, 4), null);
  assert.equal(positionSize(100, 5, 0, 4), null, 'no capital means no position');
});

test('the reported case is sized sanely', () => {
  // ₹3L at 4x was producing 2000-3000 share suggestions. Anything that large
  // must at least be fundable.
  for (const [price, risk] of [[200, 2.5], [500, 2.5], [800, 1.5]]) {
    const s = positionSize(price, risk, CAPITAL, 4);
    assert.ok(s.notional <= s.buyingPower,
      `₹${price} -> ${s.qty} shares = ₹${Math.round(s.notional)} vs ₹${s.buyingPower} available`);
  }
});
