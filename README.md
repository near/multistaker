# Multistaker

This is a simple tool that allows to setup staking to various pools from various accounts in a single Ledger.
This tool doesn't track anything and can be run locally (download the html + js and just open it local browser). Everything that tool stores is stored in local storage.

For additional privacy (paranoia level 100), run personal node should be used to query blockchain data (e.g. hide RPC requests).

## Instructions

1. Open the tool
2. Define Ledger path range to load (e.g. 44'/397'/0'/0'/1' - 44'/397'/0'/0'/5')
3. This should load all your accounts + lockups
4. Specify for each account which staking pool you want to delegate to and can edit amount (it creates a jitter around the amounts)
5. Specify period of time to send transactions during and press "Allocate"
6. This will generate transactions at once to stake everything, with different `blockHash` and schedule to submit them at random times in specified period time
6. Click a lot on Ledger to sign transactions (you should always look at what you are signing - as this is the only way to ensure you are not signing malicious transactions)
7. Wait for requested period of time to see allocations

