import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import sha256 from 'js-sha256';
import { encode, decode } from 'bs58';
import Mustache from 'mustache';

import { getSupportedTransport, createClient } from 'near-ledger-js'
import { format } from 'near-api-js/lib/utils';

const LOCKUP_BASE = 'lockup.near';

const options = {
    nodeUrl: 'https://rpc.web4.near.page',
    networkId: 'mainnet',
    deps: {}
};

window.onload = () => {
    (async () => {
        window.near = await nearAPI.connect(options);
        await loadAccounts();
    })().catch(e => console.error(e));
};

function accountToLockup(masterAccountId, accountId) {
    return `${sha256(Buffer.from(accountId)).toString('hex').slice(0, 40)}.${masterAccountId}`;
}

function formatFloat(value) {
    return nearAPI.utils.format.formatNearAmount(
        nearAPI.utils.format.parseNearAmount(value.toString()), 2);
}

function getAccounts() {
    let accounts = window.localStorage.getItem('staker-accounts');
    return accounts ? JSON.parse(accounts) : [];
}

function setAccounts(accounts) {
    window.localStorage.setItem('staker-accounts', JSON.stringify(accounts));
}

async function accountExists(connection, accountId) {
    try {
        const account = new nearAPI.Account(connection, accountId);
        await account.state();
        return true;
    } catch (error) {
        if (!error.message.includes('does not exist while viewing')) {
            throw error;
        }
        return false;
    }
}

async function fetchPools(masterAccount) {
    const result = await masterAccount.connection.provider.sendJsonRpc('validators', [null]);
    const pools = new Set();
    const stakes = new Map();
    result.current_validators.forEach((validator) => {
        pools.add(validator.account_id);
        stakes.set(validator.account_id, validator.stake);
    });
    result.next_validators.forEach((validator) => pools.add(validator.account_id));
    result.current_proposals.forEach((validator) => pools.add(validator.account_id));
    pools.add('aurora.poolv1.near');
    let poolsWithFee = [];
    let promises = []
    pools.forEach((accountId) => {
            promises.push((async () => {
                let stake = nearAPI.utils.format.formatNearAmount(stakes.get(accountId), 2);
                let fee = 0;
                try {
                    fee = await masterAccount.viewFunction(accountId, 'get_reward_fee_fraction', {});
                } catch (error) {
                   console.error(error);
                }
                poolsWithFee.push({ accountId, stake, fee: `${(fee.numerator * 100 / fee.denominator)}%` });
        })());
    });
    await Promise.all(promises);
    return poolsWithFee;
}

async function loadAccounts() {
    const selectedAccountId = window.location.hash.slice(1);
    let accounts = getAccounts();
    let account = await window.near.account('lockup.near');
    let pools = await fetchPools(account);
    let poolsSet = new Set();
    pools.forEach(({ accountId }) => poolsSet.add(accountId));
    const template = document.getElementById('template').innerHTML;
    let totalAmount = 0, totalStaked = 0, totalUnstaked = 0;
    accounts = await Promise.all(accounts.map(async ({ publicKey, path, accountId }) => {
        let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
        let amount = 0, depositedAmount = 0, stakedAmount = 0, unstakedAmount = 0, canWithdraw = false;
        let pool = null;
        if (await accountExists(window.near.connection, lockupAccountId)) {
            try {
                let lockupAccount = await window.near.account(lockupAccountId);
                amount = nearAPI.utils.format.formatNearAmount((await lockupAccount.state()).amount, 2);
                pool = await lockupAccount.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
                depositedAmount = nearAPI.utils.format.formatNearAmount(
                    await lockupAccount.viewFunction(lockupAccountId, 'get_known_deposited_balance'), 2);
                totalAmount += parseFloat(amount.replaceAll(',', ''));
                if (pool) {
                    stakedAmount = nearAPI.utils.format.formatNearAmount(
                        await lockupAccount.viewFunction(pool, 'get_account_staked_balance', { "account_id": lockupAccountId }), 2);
                    unstakedAmount = nearAPI.utils.format.formatNearAmount(
                        await lockupAccount.viewFunction(pool, 'get_account_unstaked_balance', { "account_id": lockupAccountId }), 2);
                    canWithdraw = await lockupAccount.viewFunction(pool, 'is_account_unstaked_balance_available', { account_id: lockupAccountId });
                    totalStaked += parseFloat(stakedAmount.replaceAll(',', ''));
                    totalUnstaked += parseFloat(unstakedAmount.replaceAll(',', ''));
                }
            } catch (error) {
                console.log(error);
            }
        }
        let accountIdShort = accountId.length > 32 ? `${accountId.slice(0, 4)}..${accountId.slice(-4)}` : accountId;
        let lockupIdShort = `${lockupAccountId.slice(0, 4)}..`;
        return {
            publicKey,
            path,
            accountId,
            accountIdShort,
            lockupAccountId,
            lockupIdShort,
            amount,
            depositedAmount,
            stakedAmount,
            unstakedAmount,
            canWithdraw: unstakedAmount != "0" ? `(${canWithdraw})` : "",
            pool,
            poolActive: poolsSet.has(pool) ? "active" : "out",
            selected: accountId == selectedAccountId,
        }
    }));
    totalAmount += totalStaked + totalUnstaked;
    let lastStakeTime = new Date(window.localStorage.getItem('last-stake-time'));
    let elapsedMin = Math.round((new Date() - lastStakeTime) / 1000) / 60;
    console.log(poolsSet);
    console.log(window.location.hash);
    document.getElementById('accounts').innerHTML = Mustache.render(template, {
        accounts,
        lastStakeTime,
        elapsedMin,
        totalAmount: formatFloat(totalAmount),
        totalStaked: formatFloat(totalStaked),
        totalUnstaked: formatFloat(totalUnstaked),
        pools,
    });
}

function iterPathComp(start, end) {
    let result = [];
    for (let i = start[0]; i <= end[0]; ++i) {
        if (start.length == 1) {
            result.push([i]);
        } else {
            let subItems;
            let b = start.slice(1);
            let e = end.slice(1);
            if (i != start[0]) {
                b = Array(start.length - 1).fill(255);
            }
            if (i != end[0]) {
                e = Array(end.length - 1).fill(255);
            }
            subItems = iterPathComp(b, e);
            for (let j = 0; j < subItems.length; ++j) {
                result.push([i].concat(subItems[j]));
            }
        }
    }
    return result;
}

function iterPath(start, end) {
    let sComp = start.split('\'/').map((x) => parseInt(x));
    let eComp = end.split('\'/').map((x) => parseInt(x));
    console.log(sComp, eComp);
    return iterPathComp(sComp, eComp).map((item) => item.join('\'/') + '\'');
}

console.log(nearAPI)

async function getAccountsFromKey(publicKey) {
    try {
        const result = await fetch(`https://api.fastnear.com/v0/public_key/${publicKey}/all`);
        const { account_ids } = await result.json();
        return account_ids
    } catch (e) {
        // most likely helper was deprecated
        console.warn(e)
        const implicitAccountId = nearAPI.utils.PublicKey.fromString(publicKey).data.toString('hex')
        let finalAccountId = implicitAccountId
        const exists = await accountExists(window.near.connection, implicitAccountId)
        if (!exists) {
            finalAccountId = window.prompt(`Enter AccountID for publicKey: ${publicKey.toString()}`)
        }
        if (!finalAccountId) {
            alert(`No AccountId found for publicKey: ${publicKey.toString()}`)
        }
        return [finalAccountId]
    }
}

async function addLedgerPath() {
    let start = document.querySelector('#ledger-start').value;
    let end = document.querySelector('#ledger-end').value;
    console.log(`Adding ${start} - ${end}`);
    let paths = iterPath(start, end);
    console.log(paths);
    alert(`Found: ${paths.length} paths. Now need to fetch from Ledger. If you want to cancel, refresh the page.`);
    const transport = await getSupportedTransport();
    transport.setScrambleKey("NEAR");
    let client = await createClient(transport);
    let accounts = getAccounts();
    let accountIds = accounts.map(({ accountId }) => accountId);
    for (let i = 0; i < paths.length; ++i) {
        let path = paths[i];
        try {
            let publicKey = await client.getPublicKey(path);
            let publicKeyStr = 'ed25519:' + encode(Buffer.from(publicKey));
            let curAccounts = await getAccountsFromKey(publicKeyStr);
            const implicitAccount = Buffer.from(publicKey).toString('hex');
            if (await accountExists(window.near.connection, implicitAccount)) {
                curAccounts.push(implicitAccount);
            }
            console.log(path, publicKeyStr, curAccounts);
            curAccounts.forEach((accountId) => {
                if (!accountIds.includes(accountId)) {
                    accountIds.push(accountId);
                    accounts.push({
                        path,
                        publicKey: publicKeyStr,
                        accountId,
                    });
                }
            });
        } catch (error) {
            console.log(`${path} failed: ${error}`);
        }
    }
    setAccounts(accounts);
    await loadAccounts();
}

async function setAccountSigner(contract, path, publicKey) {
    const transport = await getSupportedTransport();
    transport.setScrambleKey("NEAR");
    const client = await createClient(transport);
    publicKey = nearAPI.utils.PublicKey.fromString(publicKey);
    let signer = {
        async getPublicKey() {
            return publicKey;
        },
        async signMessage(message) {
            const signature = await client.sign(message, path);
            return { signature, publicKey };
        }
    }

    contract.connection.signer = signer;
}

function findAccount(accountId) {
    let accounts = getAccounts();
    let path, publicKey;
    accounts.forEach((account) => {
        if (account.accountId == accountId) {
            path = account.path;
            publicKey = account.publicKey;
        }
    });
    return { path, publicKey };
}

async function selectPool() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    if (!path) {
        alert("How did you select this?");
        return;
    }
    let poolId = document.querySelector('#select-pool-id').value;
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    console.log(`Select ${poolId} for ${path} / ${accountId} / ${lockupAccountId}`);
    if (!await accountExists(window.near.connection, poolId)) {
        alert(`Pool ${poolId} doesn't exist`);
        return;
    }
    let currentPool = '';
    let account
    try {
        account = await window.near.account(accountId);
        currentPool = await account.viewFunction(
            lockupAccountId,
            'get_staking_pool_account_id', 
            {});
    } catch (error) {
        console.log(error);
        alert(error);
    }
    if (currentPool && currentPool.length > 0 && currentPool !== poolId) {
        try {
            await setAccountSigner(account, path, publicKey);
            await account.functionCall(
                lockupAccountId,
                'unselect_staking_pool', 
                {},
                '25000000000000');
        } catch (error) {
            console.log(error);
            alert(error);
        }
    }
    try {
        await setAccountSigner(account, path, publicKey);
        await account.functionCall(
            lockupAccountId,
            'select_staking_pool', 
            { "staking_pool_account_id": poolId },
            '100000000000000');
    } catch (error) {
        console.log(error);
        alert(error);
    }
    await loadAccounts();
}

async function stake() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    let amount = document.querySelector('#stake-amount').value;
    console.log(`Stake ${amount} from ${path} / ${accountId}`);
    amount = nearAPI.utils.format.parseNearAmount(amount);
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    try {
        let account = await window.near.account(accountId);
        pool = await account.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
        if (!pool) {
            alert(`Lockup ${lockupAccountId} doesn't have pool selected yet`);
            return;
        }
        await setAccountSigner(account, path, publicKey);
        await account.functionCall(
            lockupAccountId,
            'deposit_and_stake',
            { 'amount': amount },
            '200000000000000');
    } catch (error) {
        console.log(error);
        alert(error);
    }
    window.localStorage.setItem('last-stake-time', new Date());
    await loadAccounts();
}

async function unstake() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    let amount = document.querySelector('#unstake-amount').value;
    console.log(`Unstake ${amount} from ${path} / ${accountId}`);
    amount = nearAPI.utils.format.parseNearAmount(amount);
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    try {
        let account = await window.near.account(accountId);
        pool = await account.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
        if (!pool) {
            alert(`Lockup ${lockupAccountId} doesn't have pool selected yet`);
            return;
        }
        await setAccountSigner(account, path, publicKey);
        if (amount == "0" || !amount) {
            await account.functionCall(
                lockupAccountId,
                'unstake_all',
                {},
                '200000000000000');
        } else {
            await account.functionCall(
                lockupAccountId,
                'unstake',
                { 'amount': amount },
                '200000000000000');
        }
    } catch (error) {
        console.log(error);
        alert(error);
    }
    await loadAccounts();
}

async function withdraw() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    let amount = document.querySelector('#withdraw-amount').value;
    console.log(`Withdraw ${amount} from ${path} / ${accountId}`);
    amount = nearAPI.utils.format.parseNearAmount(amount);
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    try {
        let account = await window.near.account(accountId);
        pool = await account.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
        if (!pool) {
            alert(`Lockup ${lockupAccountId} doesn't have pool selected yet`);
            return;
        }
        await setAccountSigner(account, path, publicKey);
        if (amount == "0" || !amount) {
            await account.functionCall(
                lockupAccountId,
                'withdraw_all_from_staking_pool',
                {},
                '200000000000000');
        } else {
            await account.functionCall(
                lockupAccountId,
                'withdraw_from_staking_pool',
                { 'amount': amount },
                '200000000000000');
        }
    } catch (error) {
        console.log(error);
        alert(error);
    }
    await loadAccounts();
}

async function transfer() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    let receiver_id = document.querySelector('#transfer-receiver').value;
    let amount = document.querySelector('#transfer-amount').value;
    console.log(`Transfer ${amount} from ${path} / ${accountId} to ${receiver_id}`);
    amount = nearAPI.utils.format.parseNearAmount(amount);
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    try {
        let account = await window.near.account(accountId);
        await setAccountSigner(account, path, publicKey);
        if (await accountExists(window.near.connection, lockupAccountId)) {
            if (!(await account.viewFunction(lockupAccountId, 'are_transfers_enabled'))) {
                await account.functionCall(lockupAccountId, 'check_transfers_vote', {}, '100000000000000')
            }
            await account.functionCall(lockupAccountId, 'transfer', {
                amount, receiver_id
            }, '100000000000000');
        }
    } catch (error) {
        console.log(error);
        alert(error);
    }
    await loadAccounts();
}

async function refreshStaking() {
    let accountId = document.querySelector('#account-id').value;
    let { path, publicKey } = findAccount(accountId);
    let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
    try {
        let account = await window.near.account(accountId);
        await setAccountSigner(account, path, publicKey);
        if (await accountExists(window.near.connection, lockupAccountId)) {
            await account.functionCall(lockupAccountId, 'refresh_staking_pool_balance', {}, '100000000000000');
        }
    } catch (error) {
        console.log(error);
        alert(error);
    }
    await loadAccounts();
}

function onAccountSelect() {
    let accountId = document.querySelector('#account-id').value;
    window.location.hash = accountId;
}

window.nearAPI = nearAPI;
window.addLedgerPath = addLedgerPath;
window.selectPool = selectPool;
window.stake = stake;
window.unstake = unstake;
window.withdraw = withdraw;
window.transfer = transfer;
window.onAccountSelect = onAccountSelect;
window.refreshStaking = refreshStaking;
