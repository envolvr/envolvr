// envolvr account app. The wallet is the account: it signs a message to manage
// the account (a 12-hour session that can manage keys and read usage, never run
// inference) and signs the deposit and staking transactions itself. API keys are
// shown once; the app keeps only the session, in this tab.

import { formatUnits, parseUnits, type Address } from 'viem';
import * as api from './api.ts';
import * as onchain from './chain.ts';
import { chain, TESTNET } from './config.ts';
import { connect, walletOptions, type Eip1193 } from './wallet.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const state: { provider?: Eip1193; address?: Address; session?: string; feeBps?: number; chain?: onchain.ChainState } = {};

const usd = (micros: string | bigint) => {
  const v = Number(BigInt(micros)) / 1e6;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v !== 0 && Math.abs(v) < 0.01 ? 6 : 2 })}`;
};
const tokens = (wei: bigint, decimals = 18) =>
  Number(formatUnits(wei, decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (unix: number) => new Date(unix * 1000).toLocaleString();
const explorerTx = (h: string) => `${chain.blockExplorers!.default.url}/tx/${h}`;

function toast(message: string, error = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = error ? 'error' : '';
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => { t.hidden = true; }, error ? 9000 : 5000);
}

/** Run an action with its button busy; show errors plainly. */
async function busy(button: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  const text = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    toast(e.shortMessage ?? e.message ?? String(err), true);
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

const sessionKey = () => `envolvr.session.${state.address?.toLowerCase()}`;
function loadSession() {
  try { state.session = sessionStorage.getItem(sessionKey()) ?? undefined; } catch { state.session = undefined; }
}
function saveSession(token?: string) {
  state.session = token;
  try { token ? sessionStorage.setItem(sessionKey(), token) : sessionStorage.removeItem(sessionKey()); } catch { /* private mode */ }
}

// ---- rendering ----

function renderWallets() {
  const list = $('walletList');
  list.replaceChildren();
  const options = walletOptions();
  $('noWallet').hidden = options.length > 0;
  for (const option of options) {
    const b = document.createElement('button');
    if (option.icon) { const img = document.createElement('img'); img.src = option.icon; img.alt = ''; b.append(img); }
    b.append(option.name);
    b.onclick = () => busy(b, 'Connecting…', async () => {
      const { provider, address } = await connect(option);
      state.provider = provider;
      state.address = address;
      provider.on?.('accountsChanged', () => location.reload());
      provider.on?.('chainChanged', () => location.reload());
      loadSession();
      $('connectPanel').hidden = true;
      $('appPanel').hidden = false;
      $('walletChip').hidden = false;
      $('walletChip').textContent = short(address);
      $('disconnect').hidden = false;
      await refresh();
    });
    list.append(b);
  }
}

async function refresh() {
  if (!state.address) return;
  const [pricing, chainState] = await Promise.all([api.pricing().catch(() => undefined), onchain.readState(state.address)]);
  state.feeBps = pricing?.depositFeeBps;
  state.chain = chainState;
  $('fee').textContent = pricing ? `${pricing.depositFeeBps / 100}%` : '–';
  $('walletUsdg').textContent = tokens(chainState.usdg, 6);
  $('walletNvlr').textContent = tokens(chainState.nvlr);
  $('walletEth').textContent = tokens(chainState.eth);
  $('staked').textContent = tokens(chainState.staked);
  const unlocked = chainState.pending.amount > 0n && chainState.pending.unlocksAt * 1000 <= Date.now();
  $('pending').textContent = chainState.pending.amount > 0n
    ? `${tokens(chainState.pending.amount)} (${unlocked ? 'unlocked' : `until ${new Date(chainState.pending.unlocksAt * 1000).toLocaleDateString()}`})`
    : '0';
  $<HTMLButtonElement>('withdraw').disabled = !unlocked;
  $('rate').textContent = chainState.totalStake > 0n
    ? usd((chainState.budgetToday * 1000n * 10n ** 18n) / chainState.totalStake) : '–';
  $('cooldown').textContent = `${Math.round(chainState.cooldown / 86400)} days`;
  $('mint').hidden = !TESTNET;
  updatePreview();
  void refreshTopUp();

  const locked = !state.session;
  document.querySelectorAll('.needs-session').forEach((el) => el.classList.toggle('locked', locked));
  $('signinBox').hidden = !locked;
  if (locked) {
    $('balance').textContent = '–';
    $('allowance').textContent = usd(chainState.allowanceToday);
    return;
  }
  try {
    const [account, keys, usage, deposits] = await Promise.all([
      api.account(state.session!), api.keys(state.session!), api.usage(state.session!), api.deposits(state.session!),
    ]);
    $('balance').textContent = usd(account.balanceMicros);
    $('allowance').textContent = `${usd(account.allowanceLeftMicros)} of ${usd(account.allowanceTodayMicros)}`;
    renderKeys(keys);
    renderUsage(usage);
    renderDeposits(deposits);
  } catch (err) {
    if ((err as { status?: number }).status === 401) { saveSession(undefined); return refresh(); }
    throw err;
  }
}

function row(cells: (string | Node)[]) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    td.append(c);
    tr.append(td);
  }
  return tr;
}

function renderKeys(keys: api.Key[]) {
  const body = $('keysTable').querySelector('tbody')!;
  body.replaceChildren(...keys.map((k) => {
    const action: Node = k.revokedAt
      ? document.createTextNode('revoked')
      : Object.assign(document.createElement('button'), {
        textContent: 'Revoke',
        onclick: (e: Event) => busy(e.currentTarget as HTMLButtonElement, 'Revoking…', async () => {
          if (!confirm(`Revoke ${k.hint ?? k.id}? Agents using it stop working at once.`)) return;
          await api.revokeKey(state.session!, k.id);
          renderKeys(await api.keys(state.session!));
          toast('Key revoked');
        }),
      });
    const tr = row([k.hint ?? k.id, k.label ?? '', new Date(k.createdAt * 1000).toLocaleDateString(), action]);
    tr.cells[0].className = 'mono';
    return tr;
  }));
  if (keys.length === 0) body.append(row(['No keys yet.', '', '', '']));
}

function renderUsage(usage: api.Usage[]) {
  const body = $('usageTable').querySelector('tbody')!;
  body.replaceChildren(...usage.map((u) => {
    const from = BigInt(u.fromAllowanceMicros) > 0n
      ? (BigInt(u.fromBalanceMicros) > 0n ? 'allowance + balance' : 'allowance') : 'balance';
    return row([when(u.at), u.model, u.route?.split(':')[0] ?? '–', usd(u.costMicros), BigInt(u.costMicros) > 0n ? from : '–']);
  }));
  if (usage.length === 0) body.append(row(['No requests yet.', '', '', '', '']));
}

function renderDeposits(deposits: api.Deposit[]) {
  const body = $('depositsTable').querySelector('tbody')!;
  body.replaceChildren(...deposits.map((d) => {
    const link = Object.assign(document.createElement('a'), { href: explorerTx(d.txHash), textContent: 'tx', target: '_blank', rel: 'noopener' });
    return row([String(d.blockNumber), `${usd(d.amountMicros)}${d.held ? ' (held)' : ''}`, usd(d.feeMicros), link]);
  }));
  if (deposits.length === 0) body.append(row(['No deposits yet.', '', '', '']));
}

function updatePreview() {
  const input = $<HTMLInputElement>('depositAmount').value.trim();
  let amount: bigint;
  try { amount = input ? parseUnits(input, 6) : 0n; } catch { amount = 0n; }
  const fee = state.feeBps === undefined ? undefined : (amount * BigInt(state.feeBps)) / 10_000n;
  $('depositPreview').textContent = amount > 0n && fee !== undefined
    ? `You will be credited ${usd(amount - fee)} (${usd(fee)} deposit fee), within seconds of the deposit being mined. Prepaid credit: it never expires and is not refundable.`
    : 'Credited to your balance, net of the deposit fee, within seconds. Prepaid credit: it never expires and is not refundable.';
}

// ---- actions ----

const sign = (message: string) => onchain.signMessage(state.provider!, state.address!, message);
const amountOf = (id: string, decimals: number) => {
  const v = $<HTMLInputElement>(id).value.trim();
  const amount = parseUnits(v || '0', decimals);
  if (amount <= 0n) throw new Error('enter an amount');
  return amount;
};

$('signin').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Check your wallet…', async () => {
  const { session } = await api.startSession(state.address!, sign);
  saveSession(session);
  await refresh();
});

$('depositAmount').oninput = updatePreview;

$('deposit').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Depositing…', async () => {
  const amount = amountOf('depositAmount', 6);
  if (state.chain && state.chain.usdg < amount) throw new Error('the wallet does not hold that much USDG');
  const hash = await onchain.deposit(state.provider!, state.address!, amount);
  toast(`Deposited. Crediting within seconds (tx ${short(hash)}).`);
  $<HTMLInputElement>('depositAmount').value = '';
  setTimeout(() => void refresh(), 8000);
  await refresh();
});

$('mint').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Minting…', async () => {
  await onchain.mintTestUsdg(state.provider!, state.address!, 20_000_000n);
  toast('20 test USDG are in your wallet');
  await refresh();
});

$('stake').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Staking…', async () => {
  const amount = amountOf('stakeAmount', 18);
  if (state.chain && state.chain.nvlr < amount) throw new Error('the wallet does not hold that much NVLR');
  await onchain.stake(state.provider!, state.address!, amount);
  toast('Staked. It counts from the next 00:00 UTC.');
  $<HTMLInputElement>('stakeAmount').value = '';
  await refresh();
});

$('unstake').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Requesting…', async () => {
  const amount = amountOf('unstakeAmount', 18);
  await onchain.requestUnstake(state.provider!, state.address!, amount);
  toast('Unstake requested; the tokens unlock after the cooldown.');
  $<HTMLInputElement>('unstakeAmount').value = '';
  await refresh();
});

$('withdraw').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Withdrawing…', async () => {
  await onchain.withdrawUnstaked(state.provider!, state.address!);
  toast('Unstaked NVLR withdrawn to your wallet');
  await refresh();
});

// ---- automatic top-up ----

function topUpAccount(): Address {
  const v = $<HTMLInputElement>('topUpAccount').value.trim();
  if (!v) return state.address! as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error('the account must be a wallet address (0x…)');
  return v as Address;
}

async function refreshTopUp() {
  if (!state.address) return;
  let account: Address;
  try { account = topUpAccount(); } catch { return; }
  const rule = await onchain.readTopUpRule(state.address as Address, account).catch(() => undefined);
  const status = $('topUpStatus');
  $('topUpOff').hidden = !rule || rule.amount === 0n;
  if (!rule) return;
  if (rule.amount === 0n) {
    status.textContent = rule.keeperActive
      ? 'No rule for this account yet. When its credit falls below the threshold, envolvr\'s attested keeper pulls the top-up amount from this wallet. The vault contract enforces the amount, the account and the daily maximum.'
      : 'Automatic top-up is not switched on yet; rules saved now apply once it is.';
    return;
  }
  const who = account.toLowerCase() === state.address.toLowerCase() ? 'this account' : short(account);
  status.textContent = `On: when ${who} falls below ${usd(rule.below)}, ${usd(rule.amount)} is added from this wallet, at most ${usd(rule.maxPerDay)} a day (${usd(rule.spentToday)} today).`
    + (rule.keeperActive ? '' : ' Top-ups start once the keeper is switched on.');
}

$('topUpAccount').onchange = () => void refreshTopUp();

$('topUpSave').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Check your wallet…', async () => {
  const account = topUpAccount();
  const below = amountOf('topUpBelow', 6);
  const amount = amountOf('topUpAmount', 6);
  const max = amountOf('topUpMax', 6);
  if (amount <= 0n) throw new Error('set a top-up amount');
  if (max < amount) throw new Error('the daily maximum must be at least the top-up amount');
  await onchain.setTopUpRule(state.provider!, state.address! as Address, account, below, amount, max);
  toast('Top-up rule saved');
  await refreshTopUp();
});

$('topUpOff').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Check your wallet…', async () => {
  await onchain.clearTopUpRule(state.provider!, state.address! as Address, topUpAccount());
  toast('Automatic top-up turned off');
  await refreshTopUp();
});

$('createKey').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Creating…', async () => {
  const label = $<HTMLInputElement>('keyLabel').value.trim() || undefined;
  const { apiKey } = await api.createKey(state.session!, label);
  $('newKey').textContent = apiKey;
  $<HTMLDialogElement>('keyDialog').showModal();
  $<HTMLInputElement>('keyLabel').value = '';
  renderKeys(await api.keys(state.session!));
});
$('copyKey').onclick = async () => {
  await navigator.clipboard.writeText($('newKey').textContent ?? '');
  toast('Copied');
};
$('closeDialog').onclick = () => {
  $('newKey').textContent = '';
  $<HTMLDialogElement>('keyDialog').close();
};

$('disconnect').onclick = async () => {
  if (state.session) await api.endSession(state.session).catch(() => undefined);
  saveSession(undefined);
  await state.provider?.disconnect?.().catch(() => undefined);
  location.reload();
};

// Wallets announce themselves right after load; list them once they have.
setTimeout(renderWallets, 150);
