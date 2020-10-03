import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import sha256 from 'js-sha256';
import { encode, decode } from 'bs58';
import Mustache from 'mustache';

import { createLedgerU2FClient } from './ledger.js'

const LOCKUP_BASE = 'lockup.near';

const options = {
    nodeUrl: 'https://rpc.mainnet.near.org',
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

async function loadAccounts() {
    let accounts = getAccounts();
    console.log(`Accounts: ${accounts}`);
    const template = document.getElementById('template').innerHTML;
    accounts = await Promise.all(accounts.map(async ({ publicKey, path, accountId }) => {
        let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
        let amount = 0, depositedAmount = 0, stakedAmount = 0;
        let pool = null;
        if (await accountExists(window.near.connection, lockupAccountId)) {
            try {
                let lockupAccount = await window.near.account(lockupAccountId);
                let state = await lockupAccount.state();
                amount = nearAPI.utils.format.formatNearAmount(state.amount, 2);
                pool = await lockupAccount.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
                depositedAmount = nearAPI.utils.format.formatNearAmount(
                    await lockupAccount.viewFunction(lockupAccountId, 'get_known_deposited_balance'), 2);
                if (pool) {
                    stakedAmount = nearAPI.utils.format.formatNearAmount(
                        await lockupAccount.viewFunction(pool, 'get_account_total_balance', { "account_id": lockupAccountId }), 2);
                }
            } catch (error) {
                console.log(error);
            }
        }
        return {
            publicKey,
            path,
            accountId,
            lockupAccountId,
            amount,
            depositedAmount,
            stakedAmount,
            pool
        }
    }));
    let lastStakeTime = new Date(window.localStorage.getItem('last-stake-time'));
    let elapsedMin = Math.round((new Date() - lastStakeTime) / 1000) / 60;
    document.getElementById('accounts').innerHTML = Mustache.render(template, {
        accounts,
        lastStakeTime,
        elapsedMin
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

async function getAccountsFromKey(publicKey) {
    const result = await fetch(`https://helper.mainnet.near.org/publicKey/${publicKey}/accountsIndexer`);
    return result.json();
}

async function addLedgerPath() {
    let start = document.querySelector('#ledger-start').value;
    let end = document.querySelector('#ledger-end').value;
    console.log(`Adding ${start} - ${end}`);
    let paths = iterPath(start, end);
    console.log(paths);
    alert(`Found: ${paths.length} paths. Now need to fetch from Ledger. If you want to cancel, refresh the page.`);
    let client = await createLedgerU2FClient();
    let accounts = getAccounts();
    let accountIds = accounts.map(({ accountId }) => accountId);
    for (let i = 0; i < paths.length; ++i) {
        let path = paths[i];
        try {
            let publicKey = await client.getPublicKey(path);
            let publicKeyStr = 'ed25519:' + encode(Buffer.from(publicKey));
            let curAccounts = await getAccountsFromKey(publicKeyStr);
            console.log(path, publicKeyStr, curAccounts);
            curAccounts.forEach((accountId) => {
                if (!accountIds.includes(accountId)) {
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
    const client = await createLedgerU2FClient();
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
    let accountId = document.querySelector('#select-account-id').value;
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
    try {
        let account = await window.near.account(accountId);
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
    let accountId = document.querySelector('#stake-account-id').value;
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

window.nearAPI = nearAPI;
window.addLedgerPath = addLedgerPath;
window.selectPool = selectPool;
window.stake = stake;