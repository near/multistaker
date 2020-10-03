import 'regenerator-runtime'

import * as nearAPI from 'near-api-js';
import { encode, decode } from 'bs58';
import Mustache from 'mustache';

import { createLedgerU2FClient } from './ledger.js'

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

function getAccounts() {
    let accounts = window.localStorage.getItem('accounts');
    return accounts ? JSON.parse(accounts) : [];
}

function setAccounts(accounts) {
    window.localStorage.setItem('accounts', JSON.stringify(accounts));
}

async function loadAccounts() {
    let accounts = getAccounts();
    console.log(`Accounts: ${accounts}`);
    const template = document.getElementById('template').innerHTML;
    document.getElementById('accounts').innerHTML = Mustache.render(template, {
        accounts
    });
}

async function addLedgerPath() {
    let start = document.querySelector('#ledger-start').value;
    let end = document.querySelector('#ledger-end').value;
    console.log(`Adding ${start} - ${end}`);
    await loadAccounts();
}

async function setAccountSigner(contract) {
    const accessKeys = await contract.getAccessKeys();
    console.log(accessKeys);
    let { publicKey, path } = await findPath(accessKeys.map(({ public_key }) => public_key));
    if (path == null) {
        alert(`Ledger path not found. Make sure to add it first in "Keys" section`);
        throw new Error(`No key found`);
    }
    console.log(`Found ${publicKey} at ${path}`);

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

window.nearAPI = nearAPI;
window.addLedgerPath = addLedgerPath;