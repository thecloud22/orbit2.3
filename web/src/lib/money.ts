const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** 150442.37 → '$150,442.37' */
export function fmtMoney(n: number): string {
  return usd.format(n)
}

/** 894180 → '$894,180' */
export function fmtMoneyShort(n: number): string {
  return usd0.format(n)
}

export function sum(ns: number[]): number {
  return Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100
}
