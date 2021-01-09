import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import sha256 from 'js-sha256';
import { encode, decode } from 'bs58';
import Mustache from 'mustache';

import { createLedgerU2FClient } from './ledger.js'
import { format } from 'near-api-js/lib/utils';

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
    let poolsWithFee = [];
    let promises = []
    pools.forEach((accountId) => {
            promises.push((async () => {
                let stake = nearAPI.utils.format.formatNearAmount(stakes.get(accountId), 2);
                let fee = await masterAccount.viewFunction(accountId, 'get_reward_fee_fraction', {});
                poolsWithFee.push({ accountId, stake, fee: `${(fee.numerator * 100 / fee.denominator)}%` });
        })());
    });
    await Promise.all(promises);
    return poolsWithFee;
}

async function loadAccounts() {
    console.log('loadAccounts');

    let accounts = getAccounts();
    console.log('accounts', accounts);
    let totalAmount = 0, totalStaked = 0, totalUnstaked = 0;
    accounts = await Promise.all(accounts.map(async ({ publicKey, path, accountId }) => {
        let lockupAccountId = accountToLockup(LOCKUP_BASE, accountId);
        let amount = 0, depositedAmount = 0, stakedAmount = 0, unstakedAmount = 0;
        let pool = null;
        if (await accountExists(window.near.connection, lockupAccountId)) {
            try {
                let lockupAccount = await window.near.account(lockupAccountId);
                let state = await lockupAccount.state();
                amount = nearAPI.utils.format.formatNearAmount(state.amount, 2);
                pool = await lockupAccount.viewFunction(lockupAccountId, 'get_staking_pool_account_id', {});
                depositedAmount = nearAPI.utils.format.formatNearAmount(
                    await lockupAccount.viewFunction(lockupAccountId, 'get_known_deposited_balance'), 2);
                totalAmount += parseFloat(amount.replaceAll(',', ''));
                // TODO: Fix totalAmount calculation
                if (pool) {
                    stakedAmount = nearAPI.utils.format.formatNearAmount(
                        await lockupAccount.viewFunction(pool, 'get_account_staked_balance', { "account_id": lockupAccountId }), 2);
                    unstakedAmount = nearAPI.utils.format.formatNearAmount(
                        await lockupAccount.viewFunction(pool, 'get_account_unstaked_balance', { "account_id": lockupAccountId }), 2);
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
            totalAmount,
            pool
        }
    }));
    totalAmount += totalStaked;
    let lastStakeTime = new Date(window.localStorage.getItem('last-stake-time'));
    let elapsedMin = Math.round((new Date() - lastStakeTime) / 1000) / 60;
    let account = await window.near.account('lockup.near');
    let pools = await fetchPools(account);
    pools.sort((a, b) => a.accountId < b.accountId ? -1 : (a.accountId > b.accountId ? 1 : 0));

    renderPools(pools);
    renderAccounts(accounts);
}

function renderPools(pools) {
    const poolAccountSelect = document.querySelector('#validators .pool-account-id');
    if (!poolAccountSelect) {
        return;
    }

    poolAccountSelect.innerHTML = '';
    poolAccountSelect.add(new Option('Choose..', ''));
    for (const pool of pools) {
        const {
            accountId,
            stake,
            fee
        } = pool;
        poolAccountSelect.add(new Option(`${accountId} -- ${fee} -- ${stake}`, accountId,));
    }
}

function renderAccounts(accounts) {
    const accountsSection = document.getElementById('accounts');
    if (!accountsSection) {
        return;
    }

    accountsSection.innerHTML = '';
    const rowTemplate = document.querySelector('#templates .account')
    for (let account of accounts) {
        const {
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
            totalAmount,
            pool
        } = account;

        const row = rowTemplate.cloneNode(true);
        row.querySelector('.ledger-path').innerHTML = path;
        row.querySelector('.account-id').innerHTML = accountIdShort;
        row.querySelector('.account-id').href = `https://explorer.near.org/accounts/${accountId}`;
        row.querySelector('.lockup-account-id').innerHTML = lockupIdShort;
        row.querySelector('.lockup-account-id').href = `https://explorer.near.org/accounts/${lockupAccountId}`;
        row.querySelector('.available-to-stake').innerHTML = formatFloat(amount);
        // TODO: Use totalAmount?
        row.querySelector('.total-balance').innerHTML = formatFloat(amount);
        Array.from(row.querySelectorAll('.pool-account-id')).forEach(elem => elem.innerHTML = pool);
        row.querySelector('.staked-amount').innerHTML = formatFloat(stakedAmount);

        if (!pool) {
            row.querySelector('.delegator.select-validator').style = '';
        } else if (!stakedAmount || stakedAmount == '0') {
            row.querySelector('.delegator.enter-stake-amount').style = '';
        } else {
            row.querySelector('.delegator.complete').style = '';
        }

        const selectValidatorModal = document.querySelector('#validators')
        const selectValidatorElem = row.querySelector('.select-validator');
        selectValidatorElem.onclick = () => {
            toggleModal(selectValidatorModal);
            document.querySelector('.select-pool').onclick = () => {
                toggleModal(selectValidatorModal);
                selectPool(accountId).catch(console.error);
            }
        }

        row.querySelector('.enter-stake-amount a').onclick = (event) => {            
            const stakeAmountInput = event.target.parentNode.parentNode.querySelector('input');
            stake(accountId, stakeAmountInput.value).then(() => {
                // TODO
            }).catch(console.error);
        }

        accountsSection.appendChild(row);
    }
}

async function getAccountsFromKey(publicKey) {
    const result = await fetch(`https://helper.mainnet.near.org/publicKey/${publicKey}/accounts`);
    return result.json();
}

async function addLedgerPaths() {
    const paths = Array.from(document.querySelectorAll('#paths input')).map(input => input.value);
    console.log('paths', paths);

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
    console.log('Public keys fetched');
    // TODO: window.location = '/accounts-approve.html'
    window.location = '/accounts.html'
}

async function setAccountSigner(contract, path, publicKey) {
    const client = await createLedgerU2FClient();
    publicKey = nearAPI.utils.PublicKey.fromString(publicKey);
    let signer = {
        async getPublicKey() {
            return publicKey;
        },
        async signMessage(message) {
            document.getElementById('ledger-tx').classList.add('is-active');
            try {
                const signature = await client.sign(message, path);
                return { signature, publicKey };
            } finally {
                document.getElementById('ledger-tx').classList.remove('is-active');
            }
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

async function selectPool(accountId) {
    console.log('selectPool', accountId);
    let { path, publicKey } = findAccount(accountId);
    if (!path) {
        alert("How did you select this?");
        return;
    }
    let poolId = document.querySelector('.pool-account-id').value;
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

async function stake(accountId, amount) {
    let { path, publicKey } = findAccount(accountId);
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
        if (amount == "0") {
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
        if (amount == "0") {
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

// TODO: Rename addFields and addField to be more specific
function addFields() {
    // Number of inputs to create
    var number = document.getElementById("number").value;
    // Container <div> where dynamic content will be placed
    var container = document.getElementById("paths");
    // Clear previous contents of the container
    while (container.hasChildNodes()) {
        container.removeChild(container.lastChild);
    }
    for (i = 0; i < number; i++) {
        // Append a node with a label
        var para = document.createElement("p");
        para.innerHTML = "Account " + (i + 1);
        para.classList.add("label");
        para.classList.add("mt-3");
        container.appendChild(para);
        // Create an <input> element, set its type and name attributes
        var input = document.createElement("input");
        input.type = "text";
        input.value = "44'/397'/0'/0'/" + (i + 2) + "'";
        input.name = "path" + i;
        input.classList.add("input");
        container.appendChild(input);
        // Append a line break 
        container.appendChild(document.createElement("br"));
    }
    //target container for the add path button
    var btnPath = document.getElementById("add-path");
    var button = document.createElement("button");
    button.innerHTML = "Add a Field";
    button.classList.add("button");
    button.setAttribute("onclick", "addField()");
    btnPath.appendChild(button);

    var button = document.createElement("button");
    button.innerHTML = "Import Ledger Accounts";
    button.classList.add("button");
    button.classList.add("is-link");
    button.classList.add("ml-5");
    button.setAttribute("onclick", "addLedgerPaths()");
    btnPath.appendChild(button);
}

function addField() {
    // Container <div> where dynamic content will be placed
    var container = document.getElementById("paths");
    // Append a node with a label
    var para = document.createElement("p");
    para.innerHTML = "Account " + (i + 1);
    para.classList.add("label");
    para.classList.add("mt-3");
    container.appendChild(para);
    // Create an <input> element, set its type and name attributes
    var input = document.createElement("input");
    input.type = "text";
    input.value = "44'/397'/0'/0'/" + (i + 2) + "'";
    input.name = "path" + i;
    input.classList.add("input");
    container.appendChild(input);
    i++;
}

Object.assign(window, {
    nearAPI,
    addLedgerPaths,
    loadAccounts,
    selectPool,
    stake,
    unstake,
    withdraw,
    addFields,
});