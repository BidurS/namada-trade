export const EXPLORERS = {
  osmoTx: (h: string) => `https://www.mintscan.io/osmosis/tx/${h}`,
  osmoAddr: (a: string) => `https://www.mintscan.io/osmosis/address/${a}`,
};

/** Osmosis ICS-20 transfer module account (worker/src/config.ts OSMOSIS.transferModule). */
export const OSMOSIS_TRANSFER_MODULE = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';

export const NAMADA = {
  internal: {
    pos: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp',
    ibc: 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4',
    masp: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah',
    pgf: 'tnam1pgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkhgajr',
    governance: 'tnam1q5qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrw33g6',
  },
  explorerTx: (h: string) => `https://namada.valopers.com/transactions/${h.toUpperCase()}`,
  explorerAddr: (a: string) => `https://namada.valopers.com/account/${a}`,
};
