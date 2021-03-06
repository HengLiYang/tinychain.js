/**
 * TODO:
 *  - threading.RLock()
 *  - @lru_cache(maxsize=1024)
 */

const crypto = require('crypto');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const net = require('net');
const BN = require('bn.js');
const RIPEMD160 = require('ripemd160');
const bs58check = require('bs58check');
const rsasign = require('jsrsasign');

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, label, printf } = format;

const logger = createLogger({
    'level': process.env['TC_LOG_LEVEL'] || 'debug',
    'format': combine(
        label({
            label: process.env['TC_LOG_LABEL'] || 'tinychain'
        }),
        format.splat(),
        format.simple(),
        timestamp(),
        printf(info => {
          return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
        })
    ),
    'transports': [
        new transports.Console()
    ]
});

const None = null;
const Params = Object.create(null, {
    // The infamous max block size.
    // bytes = 1MB
    MAX_BLOCK_SERIALIZED_SIZE: {
        value: 1000000,
        enumerable: true
    },

    // Coinbase transaction outputs can be spent after this many blocks have
    // elapsed since being mined.
    //
    // This is "100" in bitcoin core.
    COINBASE_MATURITY: {
        value: 2,
        enumerable: true
    },

    // Accept blocks timestamped as being from the future, up to this amount.
    MAX_FUTURE_BLOCK_TIME: {
        value: 60 * 60 * 2,
        enumerable: true
    },

    // The number of Belushis per coin.
    // realname COIN
    BELUSHIS_PER_COIN: {
        value: 100e6,
        enumerable: true
    },

    TOTAL_COINS: {
        value: 21000000,
        enumerable: true
    },

    // The maximum number of Belushis that will ever be found.
    MAX_MONEY: {
        get: function () {
            return this.BELUSHIS_PER_COIN * this.TOTAL_COINS;
        },
        enumerable: true
    },

    // The duration we want to pass between blocks being found, in seconds.
    // This is lower than Bitcoin's configuation (10 * 60).
    //
    // realname PowTargetSpacing
    TIME_BETWEEN_BLOCKS_IN_SECS_TARGET: {
        value: 1 * 60,
        enumerable: true
    },

    // The number of seconds we want a difficulty period to last.
    //
    // Note that this differs considerably from the behavior in Bitcoin, which
    // is configured to target difficulty periods of (10 * 2016) minutes.
    //
    // realname PowTargetTimespan
    DIFFICULTY_PERIOD_IN_SECS_TARGET: {
        value: 60 * 60 * 10,
        enumerable: true
    },

    // After this number of blocks are found, adjust difficulty.
    //
    // realname DifficultyAdjustmentInterval
    DIFFICULTY_PERIOD_IN_BLOCKS: {
        get: function () {
            return this.DIFFICULTY_PERIOD_IN_SECS_TARGET / this.TIME_BETWEEN_BLOCKS_IN_SECS_TARGET;
        },
        enumerable: true
    },

    // The number of right-shifts applied to 2 ** 256 in order to create the
    // initial difficulty target necessary for mining a block.
    INITIAL_DIFFICULTY_BITS: {
        value: 24,
        enumerable: true
    },

    // The number of blocks after which the mining subsidy will halve.
    //
    // realname SubsidyHalvingInterval
    HALVE_SUBSIDY_AFTER_BLOCKS_NUM: {
        value: 210000,
        enumerable: true
    }
});

Map.prototype.toJSON = function () {
    let obj = {};
    let keys = Array.from(this.keys()).sort();

    obj['_type'] = this.constructor.name;

    for (let key of keys) {
        obj[key] = this.get(key);
    }

    return obj;
};

Map.prototype.pop = function (key, def) {
    if (this.has(key)) {
        def = this.get(key);
        this.delete(key);
    }

    return def;
};

Date.time = function () {
    return Math.floor(Date.now() / 1000);
};

/**
 * Used to represent the specific output within a transaction.
 */
class OutPoint extends Map {
    constructor({ txid = '', txout_idx = 0 }) {
        super([
            ['txid', txid],
            ['txout_idx', txout_idx]
        ]);
    }

    get txid() {
        return this.get('txid');
    }

    get txout_idx() {
        return this.get('txout_idx');
    }
}

/**
 * Inputs to a Transaction.
 */
class TxIn extends Map {
    constructor({ to_spend = null, unlock_sig = null, unlock_pk = null, sequence = 0 }) {
        super([
            // A reference to the output we're spending. This is None for coinbase
            // transactions.
            ['to_spend', to_spend],

            // The (signature, pubkey) pair which unlocks the TxOut for spending.
            ['unlock_sig', unlock_sig],
            ['unlock_pk', unlock_pk],

            // A sender-defined sequence number which allows us replacement of the txn
            // if desired.
            ['sequence', sequence]
        ]);
    }

    get to_spend() {
        return this.get('to_spend');
    }

    get unlock_sig() {
        return this.get('unlock_sig');
    }

    get unlock_pk() {
        return this.get('unlock_pk');
    }

    get sequence() {
        return this.get('sequence');
    }
}

/**
 * Outputs from a Transaction.
 */
class TxOut extends Map {
    constructor({ value = 0, to_address = '' }) {
        super([
            // The number of Belushis this awards.
            ['value', value],
            // The public key of the owner of this Txn.
            ['to_address', to_address]
        ]);
    }

    get value() {
        return this.get('value');
    }

    get to_address() {
        return this.get('to_address');
    }
}

class UnspentTxOut extends Map {
    constructor({
        value = 0,
        to_address = '',
        txid = '',
        txout_idx = 0,
        is_coinbase = false,
        height = 0
    }) {

        super([
            ['value', value],
            ['to_address', to_address],

            // The ID of the transaction this output belongs to.
            ['txid', txid],
            ['txout_idx', txout_idx],

            // Did this TxOut from from a coinbase transaction?
            ['is_coinbase', is_coinbase],

            // The blockchain height this TxOut was included in the chain.
            ['height', height]
        ]);
    }

    get value() {
        return this.get('value');
    }

    get to_address() {
        return this.get('to_address');
    }

    get txid() {
        return this.get('txid');
    }

    get txout_idx() {
        return this.get('txout_idx');
    }

    get is_coinbase() {
        return this.get('is_coinbase');
    }

    get height() {
        return this.get('height');
    }

    get outpoint() {
        return new OutPoint({ txid: this.txid, txout_idx: this.txout_idx });
    }
}

class Transaction extends Map {
    constructor({ txins = [], txouts = [], locktime = null }) {
        super([
            ['txins', txins],
            ['txouts', txouts],
            ['locktime', locktime]
        ]);
    }

    get txins() {
        return this.get('txins');
    }

    get txouts() {
        return this.get('txouts');
    }

    get locktime() {
        return this.get('locktime');
    }

    get is_coinbase() {
        return len(this.txins) === 1 && this.txins[0].to_spend === null;
    }

    get id() {
        return sha256d(serialize(this));
    }

    validate_basics(as_coinbase = false) {
        if (!len(this.txouts) || !len(this.txins) && !as_coinbase) {
            throw new TxnValidationError('Missing txouts or txins');
        }

        for (let txout of this.txouts) {
            if (txout.value < 0) {
                throw new TxnValidationError('txout.value negative');
            }
        }

        if (len(serialize(this)) > Params.MAX_BLOCK_SERIALIZED_SIZE) {
            throw new TxnValidationError('Too large');
        }

        if (this.txouts.reduce((a, b) => a + b.value, 0) > Params.MAX_MONEY) {
            throw new TxnValidationError('Spend value too high');
        }
    }

    static create_coinbase(pay_to_addr, value, height) {
        let txin = new TxIn({
            'to_spend': null,
            'unlock_sig': bytes(height),
            'unlock_pk': null,
            'sequence': 0
        });

        let txout = new TxOut({
            'value': value,
            'to_address': pay_to_addr
        });

        return new Transaction({
            'txins': [ txin ],
            'txouts': [ txout ]
        });
    }
}

class Block extends Map {
    constructor({
        version = 0,
        prev_block_hash = 'None',
        merkle_hash = '',
        timestamp = 0,
        bits = 0,
        nonce = 0,
        txns = []
    }) {

        super([
            // A version integer.
            ['version', version],
            // A hash of the previous block's header.
            ['prev_block_hash', prev_block_hash],
            // A hash of the Merkle tree containing all txns.
            ['merkle_hash', merkle_hash],
            // UNIX timestamp of when this block was created.
            ['timestamp', timestamp],
            // The difficulty target; i.e. the hash of this block header must be under
            // (2 ** 256 >> bits) to consider work proved.
            ['bits', bits],
            // The value that's incremented in an attempt to get the block header to
            // hash to a value below `bits`.
            ['nonce', nonce],
            ['txns', txns]
        ]);
    }

    get version() {
        return this.get('version');
    }

    get prev_block_hash() {
        return this.get('prev_block_hash');
    }

    get merkle_hash() {
        return this.get('merkle_hash');
    }

    get timestamp() {
        return this.get('timestamp');
    }

    get bits() {
        return this.get('bits');
    }

    get nonce() {
        return this.get('nonce');
    }

    get txns() {
        return this.get('txns');
    }

    /**
     * This is hashed in an attempt to discover a nonce under the difficulty
     * target.
     */
    header(nonce = null) {
        nonce = nonce || this.nonce;
        return `${this.version}${this.prev_block_hash}${this.merkle_hash}${this.timestamp}${this.bits}${nonce}`;
    }

    get id() {
        return sha256d(this.header());
    }
}

// Chain
// ----------------------------------------------------------------------------

const genesis_block = new Block({
    'version': 0,
    'prev_block_hash': 'None',
    'merkle_hash': '7118894203235a955a908c0abfc6d8fe6edec47b0a04ce1bf7263da3b4366d22',
    'timestamp': 1501821412,
    'bits': 24,
    'nonce': 10126761,
    'txns': [ new Transaction({
        'txins': [ new TxIn({
            'to_spend': null,
            'unlock_sig': bytes(0),
            'unlock_pk': null,
            'sequence': 0
        }) ],
        'txouts': [ new TxOut({
            'value': 5000000000,
            'to_address': '143UVyz7ooiAv1pMqbwPPpnH4BV9ifJGFF'
        }) ],
        'locktime': null
    }) ]
});

// The highest proof-of-work, valid blockchain.
//
// realname chainActive
const active_chain = [ genesis_block ];

// Branches off of the main chain.
const side_branches = [];

// Synchronize access to the active chain and side branches.
const chain_lock = {}; /* TODO: threading.RLock() */

const orphan_blocks = [];

// Used to signify the active chain in `locate_block`.
const ACTIVE_CHAIN_IDX = 0;

function get_current_height() {
    return len(active_chain);
}

function txn_iterator(chain) {
    let txn = [];
    for (let [ height, block ] of chain.entries()) {
        for (let tx of block.txns) {
            txn.push([ tx, block, height ]);
        }
    }

    return txn;
}

function locate_block(block_hash, chain = null) {
    let chains = chain ? [ chain ]
                        : [ active_chain ].concat(side_branches);

    for (let [ chain_idx, chain ] of chains.entries()) {
        for (let [ height, block ] of chain.entries()) {
            if (block.id === block_hash) {
                return [ block, height, chain_idx ];
            }
        }
    }

    return [ None, None, None ];
}

/**
 * Accept a block and return the chain index we append it to.
 */

function connect_block(block, doing_reorg = false) {
    // Only exit early on already seen in active_chain when reorging.
    let search_chain = doing_reorg ? active_chain : None;
    let chain_idx;

    if (locate_block(block.id, search_chain)[0]) {
        logger.debug(`ignore block already seen: ${block.id}`);
        return None;
    }

    try {
        [ block, chain_idx ] = validate_block(block);
    } catch (e) {
        logger.warn('block %s failed validation', block.id);
        if (e.to_orphan) {
            logger.info(`saw orphan block ${block.id}`);
            orphan_blocks.push(e.to_orphan);
        }
        return None;
    }

    // If `validate_block()` returned a non-existent chain index, we're
    // creating a new side branch.
    if (chain_idx !== ACTIVE_CHAIN_IDX && len(side_branches) < chain_idx) {
        logger.info(`creating a new side branch (idx ${chain_idx}) for block ${block.id}`);
        side_branches.push([]);
    }

    logger.info(`connecting block ${block.id} to chain ${chain_idx}`);
    let chain = chain_idx === ACTIVE_CHAIN_IDX ? active_chain : side_branches[ chain_idx - 1 ];
    chain.push(block);

    // If we added to the active chain, perform upkeep on utxo_set and mempool.
    if (chain_idx === ACTIVE_CHAIN_IDX) {
        for (let tx of block.txns) {
            mempool.pop(tx.id, None);

            if (!tx.is_coinbase) {
                for (let txin of tx.txins) {
                    let { txid, txout_idx } = txin.to_spend;
                    rm_from_utxo(txid, txout_idx);
                }
            }

            for (let [ i, txout ] of tx.txouts.entries()) {
                add_to_utxo(txout, tx, i, tx.is_coinbase, len(chain));
            }
        }
    }

    if (!doing_reorg && reorg_if_necessary() || chain_idx === ACTIVE_CHAIN_IDX) {
        mine_interrupt.set();
        logger.info(`block accepted height=${len(active_chain) - 1} txns=${len(block.txns)}`);
    }

    for (let peer of peer_hostnames) {
        send_to_peer(block, peer);
    }

    return chain_idx;
}

function disconnect_block(block, chain = None) {
    chain = chain || active_chain;
    assert(block === chain[ chain.length - 1 ], 'Block being disconnected must be tip.');

    for (let tx of block.txns) {
        mempool.set(tx.id, tx);

        // Restore UTXO set to what it was before this block.
        for (let txin of tx.txins) {
            // Account for degenerate coinbase txins.
            if (txin.to_spend) {
                add_to_utxo([ ...find_txout_for_txin(txin, chain) ]);
            }
        }

        for (let i = 0; i < len(tx.txouts); i++) {
            rm_from_utxo(tx.id, i);
        }
    }

    logger.info(`block ${block.id} disconnected`);
    return chain.pop()
}

function find_txout_for_txin(txin, chain) {
    let { txid, txout_idx } = txin.to_spend;

    for (let [ tx, block, height ] of txn_iterator(chain)) {
        if (tx.id === txid) {
            let txout = tx.txouts[txout_idx];
            return [ txout, tx, txout_idx, tx.is_coinbase, height ];
        }
    }
}

function reorg_if_necessary() {
    let reorged = false;
    // May change during this call.
    let frozen_side_branches = side_branches.concat([]);

    // TODO should probably be using `chainwork` for the basis of
    // comparison here.
    for (let [ branch_idx, chain ] of frozen_side_branches.entries()) {
        let [ fork_block, fork_idx, _ ] = locate_block(chain[0].prev_block_hash, active_chain);
        let active_height = len(active_chain);
        let branch_height = len(chain) + fork_idx;

        if (branch_height > active_height) {
            logger.info(`attempting reorg of idx ${branch_idx} to active_chain - new height of ${branch_height} (vs. ${active_height})`);
            reorged |= try_reorg(chain, branch_idx + 1, fork_idx);
        }
    }

    return reorged;
}

function try_reorg(branch, branch_idx, fork_idx) {
    /**
     * Node NOT need
     *
     * // Use the global keyword so that we can actually swap out the reference
     * // in case of a reorg.
     * global active_chain
     * global side_branches
     */

    let fork_block = active_chain[fork_idx];

    function* disconnect_to_fork() {
        let last = len(active_chain) - 1;
        while (active_chain[last].id !== fork_block.id) {
            yield disconnect_block(active_chain[last]);
            last = len(active_chain) - 1;
        }
    }

    let old_active = [ ...disconnect_to_fork() ].reverse();

    assert(branch[0].prev_block_hash === active_chain[len(active_chain) - 1].id);

    function rollback_reorg() {
        logger.info(`reorg of idx ${branch_idx} to active_chain failed`);

        // Force the generator to eval.
        [ ...disconnect_to_fork() ];

        for (let block of old_active) {
            assert(connect_block(block, true) === ACTIVE_CHAIN_IDX);
        }
    }

    for (let block of branch) {
        let connected_idx = connect_block(block, true);
        if (connected_idx !== ACTIVE_CHAIN_IDX) {
            rollback_reorg();
            return false;
        }
    }

    // Fix up side branches: remove new active, add old active.
    side_branches.splice(branch_idx - 1, 1);
    side_branches.push(old_active);

    logger.info('chain reorg! New height: %s, tip: %s', len(active_chain), active_chain[len(active_chain) - 1].id);

    return true;
}

/**
 * Grep for: GetMedianTimePast.
 */
function get_median_time_past(num_last_blocks) {
    // TODO: improve
    let copy_chain = active_chain.concat([]);
    let last_n_blocks = copy_chain.reverse().slice(0, num_last_blocks);

    if (!len(last_n_blocks)) {
        return 0;
    }

    return last_n_blocks[Math.floor(len(last_n_blocks) / 2)].timestamp;
}

// Chain Persistance
// ----------------------------------------------------------------------------
const CHAIN_PATH = path.join(__dirname, process.env['TC_CHAIN_PATH'] || 'chain.dat');

function save_to_disk() {
    logger.info(`saving chain with ${len(active_chain)} blocks`);
    fs.writeFileSync(CHAIN_PATH, encode_socket_data(active_chain));
}

function load_from_disk() {
    if (!fs.existsSync(CHAIN_PATH)) {
        return;
    }

    try {
        // TODO: read stream
        let data = fs.readFileSync(CHAIN_PATH);
        let dataLen = data.readUInt32BE(0);
        let newBlocks = deserialize(data.slice(4).toString());

        for (let block of newBlocks) {
            connect_block(block);
        }
    } catch (e) {
        logger.warn('load chain failed, starting from genesis');
    }
}

// UTXO set
// ----------------------------------------------------------------------------

class UTXOs extends Map {
    set(k, v) {
        super.set(this.toStr(k), v);
    }

    get(k) {
        return super.get(this.toStr(k));
    }

    has(k) {
        return super.has(this.toStr(k));
    }

    delete(k) {
        return super.delete(this.toStr(k));
    }

    toStr(k) {
        return [...k].toString();
    }

    toJSON() {
        return Array.from(this.entries());
    }
}

const utxo_set = new UTXOs;

function add_to_utxo(txout, tx, idx, is_coinbase, height) {
    let utxo = new UnspentTxOut({
        value: txout.value,
        to_address: txout.to_address,
        txid: tx.id,
        txout_idx: idx,
        is_coinbase: is_coinbase,
        height: height
    });

    logger.info(`adding tx outpoint ${JSON.stringify(utxo.outpoint)} to utxo_set`);
    utxo_set.set(utxo.outpoint, utxo);
}

function rm_from_utxo(txid, txout_idx) {
    utxo_set.delete(new OutPoint({ txid: txid, txout_idx: txout_idx }));
}

function find_utxo_in_list(txin, txns) {
    let { txid, txout_idx } = txin.to_spend;
    let txout;

    try {
        txout = txns.filter( t => {
            return t.id === txid;
        })[0].txouts[txout_idx];
    } catch (e) {
        return None;
    }

    return new UnspentTxOut({
        value: txout.value,
        to_address: txout.to_address,
        txid: tx.id,
        txout_idx: txout_idx,
        is_coinbase: false,
        height: -1
    });
}

// Proof of work
// ----------------------------------------------------------------------------

/**
 * Based on the chain, return the number of difficulty bits the next block
 * must solve.
 */
function get_next_work_required(prev_block_hash) {
    if (prev_block_hash === 'None') {
        return Params.INITIAL_DIFFICULTY_BITS;
    }

    let [ prev_block, prev_height, _ ] = locate_block(prev_block_hash);

    if ((prev_height + 1) % Params.DIFFICULTY_PERIOD_IN_BLOCKS !== 0) {
        return prev_block.bits;
    }

    // with chain_lock:
    //     # #realname CalculateNextWorkRequired
    let period_start_block = active_chain[Math.max(
            prev_height - (Params.DIFFICULTY_PERIOD_IN_BLOCKS - 1), 0)];

    let actual_time_taken = prev_block.timestamp - period_start_block.timestamp;

    if (actual_time_taken < Params.DIFFICULTY_PERIOD_IN_SECS_TARGET) {
        // Increase the difficulty
        return prev_block.bits + 1;
    }
    else if (actual_time_taken > Params.DIFFICULTY_PERIOD_IN_SECS_TARGET) {
        return prev_block.bits - 1;
    }
    else {
        // Wow, that's unlikely.
        return prev_block.bits;
    }
}

/**
 * Given the txns in a Block, subtract the amount of coin output from the
 * inputs. This is kept as a reward by the miner.
 */
function calculate_fees(block) {
    let fee = 0;

    function utxo_from_block(txin) {
        let tx = block.txns.filter(t => {
            return t.id === txin.to_spend.txid;
        }).map(t => t.txouts);

        if (len(tx)) {
            return tx[0][txin.to_spend.txout_idx];
        }

        return None;
    }

    function find_utxo(txin) {
        return utxo_set.get(txin.to_spend) || utxo_from_block(txin);
    }

    for (let txn of block.txns) {
        let spent = txn.txins.reduce((sum, i) => {
            return sum + find_utxo(i).value;
        }, 0);

        let sent = txn.txouts.reduce((sum, o) => {
            return sum + o.value;
        }, 0);

        fee += (spent - sent);
    }

    return fee;
}

function get_block_subsidy() {
    let halvings = Math.floor(len(active_chain) / Params.HALVE_SUBSIDY_AFTER_BLOCKS_NUM);

    if (halvings >= 64) {
        return 0;
    }

    return Math.floor(50 * Params.BELUSHIS_PER_COIN / Math.pow(2, halvings));
}

/**
 * Construct a Block by pulling transactions from the mempool, then mine it.
 */
const assemble_and_solve_block = async function (pay_coinbase_to_addr, txns = None) {
    let prev_block_hash = active_chain[len(active_chain) - 1].id;

    let block = new Block({
        'version': 0,
        'prev_block_hash': prev_block_hash,
        'merkle_hash': '',
        'timestamp': Date.time(),
        'bits': get_next_work_required(prev_block_hash),
        'nonce': 0,
        'txns': txns || []
    });

    if (!len(block.txns)) {
        block = select_from_mempool(block);
    }

    let fees = calculate_fees(block);
    let coinbase_txn = Transaction.create_coinbase(
        pay_coinbase_to_addr, (get_block_subsidy() + fees), len(active_chain));

    block.set('txns', [ coinbase_txn ].concat(block.txns));
    block.set('merkle_hash',get_merkle_root_of_txns(block.txns).val);

    if (len(serialize(block)) > Params.MAX_BLOCK_SERIALIZED_SIZE) {
        throw new Error('txns specified create a block too large');
    }

    return await mine(block);
};

class Child {
    constructor(resolve, reject, file = 'worker.js') {
        const bin = process.argv[0];
        const options = { stdio: 'pipe', env: process.env };

        this._resolve = resolve;
        this._reject = reject;

        this._worker = cp.spawn(bin, [ path.resolve(__dirname, file) ], options);
        this._miner = new SocketMessageHandle(data => {
            let { nonce, error } = data;
            if (nonce === undefined) {
                return reject(error);
            }

            resolve(nonce);
        });

        this.init();
    }

    init() {
        this._worker.unref();
        this._worker.stdin.unref();
        this._worker.stdout.unref();
        this._worker.stderr.unref();

        this._worker.stdout.on('data', chunk => {
            this._miner.read_all_from_socket(chunk);
        });

        let onError = this.destroy.bind(this);
        this._worker.on('error', onError);
        this._worker.stdin.on('error', onError);
        this._worker.stdout.on('error', onError);
    }

    send(data) {
        this._worker.stdin.write(encode_socket_data(data));
    }

    destroy(err = { message: 'interrupt' }) {
        this._reject(err);
        if (!this._worker.killed) {
            this._worker.kill();
        }
    }
}

class Miner extends Set {
    set() {
        for (let child of this.values()) {
            child.destroy();
            this.delete(child);
        }
    }
}

// Signal to communicate to the mining thread that it should stop mining because
// we've updated the chain with a new block.
const mine_interrupt = new Miner();

const mine = async function mine(block) {
    let start = Date.time();

    let nonce = await new Promise((resolve, reject) => {
        let miner = new Child(resolve, reject);
        mine_interrupt.add(miner);

        miner.send({
            'header': [
                block.version,
                block.prev_block_hash,
                block.merkle_hash,
                block.timestamp,
                block.bits,
                block.nonce
            ],
            'bits': block.bits
        });
    }).catch(err => {
        logger.error('mine error %s', err.message)
        return -1;
    });

    if (nonce === -1) {
        return None;
    }

    let duration = (Date.time() - start) || 0.001;
    let khs = Math.floor((nonce / duration) / 1000);
    logger.info('mined block! %d s - %d KH/s %d', duration, khs, nonce);

    return new Block({
        version: block.version,
        prev_block_hash: block.prev_block_hash,
        merkle_hash: block.merkle_hash,
        timestamp: block.timestamp,
        bits: block.bits,
        nonce: nonce,
        txns: block.txns
    });
};

const mine_forever = async function mine_forever() {
    for (;;) {
        let my_address = init_wallet()[2];
        let block = await assemble_and_solve_block(my_address);

        if (block) {
            connect_block(block);
            save_to_disk();
        }
    }
};

// Validation
// ----------------------------------------------------------------------------

/**
 * Validate a single transaction. Used in various contexts, so the
 * parameters facilitate different uses.
 */
function validate_txn(txn, as_coinbase = false, siblings_in_block = None, allow_utxo_from_mempool = true) {
    txn.validate_basics(as_coinbase);

    let available_to_spend = 0;

    for (let [ i, txin ] of txn.txins.entries()) {
        let utxo = utxo_set.get(txin.to_spend);

        if (siblings_in_block) {
            utxo = utxo || find_utxo_in_list(txin, siblings_in_block);
        }

        if (allow_utxo_from_mempool) {
            utxo = utxo || find_utxo_in_mempool(txin);
        }

        if (!utxo) {
            throw new TxnValidationError(
                `Could find no UTXO for TxIn[${i}] -- orphaning txn`,
                txn);
        }

        if (utxo.is_coinbase
            && (get_current_height() - utxo.height) < Params.COINBASE_MATURITY) {

            throw new TxnValidationError('Coinbase UTXO not ready for spend');
        }

        try {
            validate_signature_for_spend(txin, utxo, txn);
        } catch (e) {
            if (e instanceof TxUnlockError) {
                throw new TxnValidationError(`${txin} is not a valid spend of ${utxo}`);
            }

            throw e;
        }

        available_to_spend += utxo.value;
    }

    if (available_to_spend < txn.txouts.reduce((sum, i) => { return sum + i.value; }, 0)) {
        throw new TxnValidationError('Spend value is more than available');
    }

    return txn;
}

function validate_signature_for_spend(txin, utxo, txn) {
    let pubkey_as_addr = pubkey_to_address(txin.unlock_pk);

    if (pubkey_as_addr != utxo.to_address) {
        throw new TxUnlockError("Pubkey doesn't match");
    }

    let spend_msg = build_spend_message(
        txin.to_spend, txin.unlock_pk, txin.sequence, txn.txouts);

    let verifying_key = new rsasign.Signature({ "alg": 'SHA256withECDSA' });
    verifying_key.init({ xy: txin.unlock_pk, curve: 'secp256k1' });
    verifying_key.updateString(spend_msg);

    if (verifying_key.verify(txin.unlock_sig)) {
        return true;
    }
    else {
        throw new TxUnlockError("Signature doesn't match");
    }
}

/**
 * This should be ~roughly~ equivalent to SIGHASH_ALL.
 */
function build_spend_message(to_spend, pk, sequence, txouts) {
    return sha256d(serialize(to_spend) + sequence + pk + serialize(txouts));
}

function validate_block(block) {
    if (!len(block.txns)) {
        throw new BlockValidationError('txns empty');
    }

    if (block.timestamp - Date.time() > Params.MAX_FUTURE_BLOCK_TIME) {
        throw new BlockValidationError('Block timestamp too far in future');
    }

    let a = new BN(block.id, 16);
    let b = new BN(0);

    if (a.gt(b.bincn(256 - block.bits))) {
        throw new BlockValidationError("Block header doesn't satisfy bits");
    }

    if (!block.txns[0].is_coinbase) {
        throw new BlockValidationError('First txn must be coinbase and no more');
    }

    let i, txn;
    try {
        for ([ i, txn ] of block.txns.entries()) {
            txn.validate_basics(i === 0);
        }
    } catch (e) {
        if (e instanceof TxnValidationError) {
            logger.warn(`Transaction ${txn} in ${block} failed to validate`);
            throw new BlockValidationError(`Invalid txn ${txn.id}`);
        }

        throw e;
    }

    if (get_merkle_root_of_txns(block.txns).val !== block.merkle_hash) {
        throw new BlockValidationError('Merkle hash invalid');
    }

    if (block.timestamp <= get_median_time_past(11)) {
        throw new BlockValidationError('timestamp too old');
    }

    let prev_block_chain_idx;
    let prev_block;
    let prev_block_height;
    if (block.prev_block_hash === 'None' && !len(active_chain)) {
        // This is the genesis block.
        prev_block_chain_idx = ACTIVE_CHAIN_IDX;
    }
    else {
        [ prev_block, prev_block_height, prev_block_chain_idx ] = locate_block(
            block.prev_block_hash);

        if (!prev_block) {
            throw new BlockValidationError(
                `prev block ${block.prev_block_hash} not found in any chain`,
                block);
        }

        // No more validation for a block getting attached to a branch.
        if (prev_block_chain_idx !== ACTIVE_CHAIN_IDX) {
            return [ block, prev_block_chain_idx ];
        }
        // Prev. block found in active chain, but isn't tip => new fork.
        else if (prev_block !== active_chain[len(active_chain) - 1]) {
            // Non-existent
            return [ block , prev_block_chain_idx + 1 ];
        }
    }

    if (get_next_work_required(block.prev_block_hash) !== block.bits) {
        throw new BlockValidationError('bits is incorrect');
    }

    for (let txn of block.txns.slice(1)) {
        try {
            validate_txn(txn, block.txns.slice(1), false);
        } catch (e) {
            if (e instanceof TxnValidationError) {
                let msg = `${txn} failed to validate`;
                logger.warn(msg)
                throw new BlockValidationError(msg);
            }

            throw e;
        }
    }

    return [ block, prev_block_chain_idx ];
}

// mempool
// ----------------------------------------------------------------------------

// Set of yet-unmined transactions.
const mempool = new Map();

// Set of orphaned (i.e. has inputs referencing yet non-existent UTXOs)
// transactions.
const orphan_txns = [];

function find_utxo_in_mempool(txin) {
    let { txid, idx } = txin.to_spend;
    let txout;

    console.log(txid, idx);

    try {
        txout = mempool.get(txid).txouts[idx];
    } catch (e) {
        logger.debug("Couldn't find utxo in mempool for %s", txin);
        return None;
    }

    return new UnspentTxOut({
        value: txout.value,
        to_address: txout.to_address,
        txid: txid,
        is_coinbase: false,
        height: -1,
        txout_idx: idx
    });
}

/**
 * Fill a Block with transactions from the mempool.
 */
function select_from_mempool(block) {
    let added_to_block = new Set();

    function check_block_size(block) {
        return len(serialize(block)) < Params.MAX_BLOCK_SERIALIZED_SIZE;
    }

    function try_add_to_block(block, txid) {
        if (added_to_block.has(txid)) {
            return block;
        }

        let tx = mempool.get(txid);

        // For any txin that can't be found in the main chain, find its
        // transaction in the mempool (if it exists) and add it to the block.
        for (const txin of tx.txins) {

            if (utxo_set.has(txin.to_spend)) {
                continue;
            }

            let in_mempool = find_utxo_in_mempool(txin);

            if (!in_mempool) {
                logger.debug(`Couldn't find UTXO for ${txin}`);
                return null;
            }

            block = try_add_to_block(block, in_mempool.txid);
            if (!block) {
                logger.debug("Couldn't add parent")
                return null;
            }
        }

        let newblock = new Block({
            version: block.version,
            prev_block_hash: block.prev_block_hash,
            merkle_hash: block.merkle_hash,
            timestamp: block.timestamp,
            bits: block.bits,
            nonce: block.nonce,
            txns: block.txns.concat([ tx ])
        });

        if (check_block_size(newblock)) {
            logger.debug(`added tx ${tx.id} to block`);
            added_to_block.add(txid);
            return newblock;
        }

        return block;
    }

    for (const txid of mempool.keys()) {
        let newblock = try_add_to_block(block, txid);

        if (check_block_size(newblock)) {
            block = newblock;
        }
        else {
            break;
        }
    }

    return block;
}

function add_txn_to_mempool(txn) {
    if (mempool.has(txn.id)) {
        logger.info(`txn ${txn.id} already seen`);
        return;
    }

    try {
        txn = validate_txn(txn);
    } catch (e) {
        if (e.to_orphan) {
            logger.info(`txn ${e.to_orphan.id} submitted as orphan`);
            orphan_txns.push(e.to_orphan);
            return;
        }

        logger.warn('txn rejected: %o', e);
        return;
    }

    logger.info(`txn ${txn.id} added to mempool`);
    mempool.set(txn.id, txn);

    for (let peer of peer_hostnames) {
        send_to_peer(txn, peer);
    }
}

// Merkle trees
// ----------------------------------------------------------------------------

class MerkleNode extends Map {
    constructor({ val = '', children = [] }) {
        super([
            ['val', val],
            ['children', children]
        ]);
    }

    get val() {
        return this.get('val');
    }

    get children() {
        return this.get('children');
    }
}

function get_merkle_root_of_txns(txns) {
    return get_merkle_root.apply(null, txns.map(t => t.id));
}

/**
 * Builds a Merkle tree and returns the root given some leaf values.
 */
function get_merkle_root(...leaves) {
    if (len(leaves) % 2 == 1) {
        leaves.push(leaves[len(leaves) - 1]);
    }

    function find_root(nodes) {
        let newlevel = _chunks(nodes, 2).map(node => {
            let [ i1, i2 ] = node;
            return new MerkleNode({
                val: sha256d(i1.val + i2.val),
                children: [i1, i2]
            });
        });

        if (newlevel.length > 1) {
            return find_root(newlevel);
        }

        return newlevel[0];
    }

    return find_root(leaves.map(l => {
        return new MerkleNode({ val: sha256d(l) });
    }));
}

// Peer-to-peer
// ----------------------------------------------------------------------------

const peer_hostnames = new Set((process.env['TC_PEERS'] || '').split(',').filter(p => p));

// Signal when the initial block download has completed.
const ibd_done = {}; /*threading.Event()*/

/**
 * See https://bitcoin.org/en/developer-guide#blocks-first
 * Request blocks during initial sync
 */
class GetBlocksMsg extends Map {
    constructor({ from_blockid, CHUNK_SIZE = 50 }) {
        super([
            ['from_blockid', from_blockid],
            ['CHUNK_SIZE', CHUNK_SIZE]
        ]);
    }

    get from_blockid() {
        return this.get('from_blockid');
    }

    get CHUNK_SIZE() {
        return this.get('CHUNK_SIZE');
    }

    handle(sock, peer_hostname) {
        logger.info(`[p2p] recv getblocks from ${peer_hostname}`);

        let [ _, height, __ ] = locate_block(this.from_blockid, active_chain);

        // If we don't recognize the requested hash as part of the active
        // chain, start at the genesis block.
        height = height || 1;

        let blocks = active_chain.slice(height, height + this.CHUNK_SIZE);

        logger.debug(`[p2p] sending ${len(blocks)} to ${peer_hostname}`);
        send_to_peer(new InvMsg({ blocks: blocks }), peer_hostname);
    }
}

/**
 * Convey blocks to a peer who is doing initial sync
 */
class InvMsg extends Map {
    constructor({ blocks }) {
        super([
            ['blocks', blocks]
        ]);
    }

    get blocks() {
        return this.get('blocks');
    }

    handle(sock, peer_hostname) {
        logger.info(`[p2p] recv inv from ${peer_hostname}`);

        let new_blocks = this.blocks.filter(b => {
            return !locate_block(b.id)[0];
        });

        if (!len(new_blocks)) {
            logger.info('[p2p] initial block download complete');
            return;
        }

        for (let block of new_blocks) {
            connect_block(block);
        }

        let new_tip_id = active_chain[len(active_chain) - 1].id;
        logger.info(`[p2p] continuing initial block download at ${new_tip_id}`);

        // "Recursive" call to continue the initial block sync.
        send_to_peer(new GetBlocksMsg({ from_blockid: new_tip_id }));
    }
}

/**
 * List all UTXOs
 */
class GetUTXOsMsg extends Map {
    constructor() {
        super();
    }

    handle(sock, peer_hostname) {
        sock.end(encode_socket_data(utxo_set));
    }
}

/**
 * List the mempool
 */
class GetMempoolMsg extends Map {
    constructor() {
        super();
    }

    handle(sock, peer_hostname) {
        sock.end(encode_socket_data(Array.from(mempool.keys())));
    }
}

/**
 * Get the active chain in its entirety.
 */
class GetActiveChainMsg extends Map {
    constructor() {
        super();
    }

    handle(sock, peer_hostname) {
        sock.end(encode_socket_data(active_chain));
    }
}

class AddPeerMsg extends Map {
    constructor({ peer_hostname }) {
        super([
            ['peer_hostname', peer_hostname]
        ]);
    }

    get peer_hostname() {
        return this.get('peer_hostname');
    }

    handle(sock, peer_hostname) {
        peer_hostnames.add(this.peer_hostname);
    }
}

class SocketMessageHandle {
    constructor(handle) {
        this.total = 0;
        this.pending = [];
        this.waiting = 4;
        this.isHeader = true;
        this.handle = handle;
    }

    read_all_from_socket(data) {
        this.total += data.length;
        this.pending.push(data);

        while (this.total >= this.waiting) {
            this._parse(this._read(this.waiting));
        };
    }

    _read(size) {
        if (size === 0) {
            return Buffer.alloc(0);
        }

        const pending = this.pending[0];
        if (pending.length > size) {
            const chunk = pending.slice(0, size);
            this.pending[0] = pending.slice(size);
            this.total -= chunk.length;
            return chunk;
        }

        if (pending.length === size) {
            const chunk = this.pending.shift();
            this.total -= chunk.length;
            return chunk;
        }

        const chunk = Buffer.allocUnsafe(size);
        let off = 0;

        while (off < chunk.length) {
            const pending = this.pending[0];
            const len = pending.copy(chunk, off);

            if (len === pending.length)
                this.pending.shift();
            else
                this.pending[0] = pending.slice(len);

            off += len;
        }

        this.total -= chunk.length;

        return chunk;
    }

    _parse(data) {
        if (!data.length) {
            return;
        }

        if (this.isHeader) {
            this.isHeader = false;
            this.waiting = data.readUInt32BE(0);
            return;
        }

        this.isHeader = true;
        this.waiting = 4;
        this.handle(deserialize(data.toString()));
    }
}

/**
 * Send a message to a (by default) random peer.
 */
const send_to_peer = async function send_to_peer(data, peer = None) {
    if (!peer) {
        let rnd = Math.floor(Math.random() * len(peer_hostnames));
        if (!(peer = Array.from(peer_hostnames)[rnd])) {
            return;
        }
    }

    let tries_left = 3;

    while (tries_left > 0) {
        let code = await new Promise((resolve, reject) => {

            function retry() {
                tries_left -= 1;
                reject('limit maximum retries');
            }

            let socket = new net.Socket;

            socket.setTimeout(10000, () => {
                socket.end();
                retry();
            });

            socket.connect(PORT, peer, () => {
                socket.end(encode_socket_data(data));
                resolve('end');
            });

            socket.on('error', (e) => {
                logger.warn(`failed to send to peer ${peer}`);
                retry();
            });
        }).catch(e => {
            logger.error(e);
            return 'end';
        });

        if (code === 'end') {
            return code;
        }
    }

    logger.info(`[p2p] removing dead peer ${peer}`);
    peer_hostnames.delete(peer);
}

/**
 * Our protocol is: first 4 bytes signify msg length.
 */
function encode_socket_data(data) {
    let to_send = Buffer.from(serialize(data), 'utf8');
    let len = to_send.length + 4;
    let buf = Buffer.allocUnsafe(len);

    buf.writeUInt32BE(len - 4, 0);
    to_send.copy(buf, 4);

    return buf;
}

function tcp_server(port, host = '0.0.0.0') {
    return net.createServer((socket) => {
        const message = new SocketMessageHandle(data => {
            let peer_hostname = socket.remoteAddress;
            peer_hostnames.add(peer_hostname);

            if (data.handle && data.handle instanceof Function) {
                logger.info(`received msg ${JSON.stringify(data)} from peer ${peer_hostname}`);
                data.handle(socket, peer_hostname);
            }
            else if (data instanceof Transaction) {
                logger.info(`received txn ${data.id} from peer ${peer_hostname}`);
                add_txn_to_mempool(data);
                socket.end();
            }
            else if (data instanceof Block) {
                logger.info(`received block ${data.id} from peer ${peer_hostname}`);
                connect_block(data);
                socket.end();
            }
        });

        socket.on('data', (chunk) => {
            message.read_all_from_socket(chunk);
        });
    }).listen(port, host);
}

// Wallet
// ----------------------------------------------------------------------------

const WALLET_PATH = process.env['TC_WALLET_PATH'] || 'wallet.dat';

function pubkey_to_address(pubkey) {
    let bPubkey = Buffer.from(bytes(pubkey), 'hex');
    let bPrefix = Buffer.from(bytes('\x00'), 'hex');

    let sha = sha256(bPubkey);
    let ripe = new RIPEMD160().update(sha).digest();

    return bs58check.encode(Buffer.concat([bPrefix, ripe]));
}

function init_wallet(wallet = null) {
    wallet = path.join(__dirname, wallet || WALLET_PATH);

    let signing_key, verifying_key, my_address;
    let ecdh = crypto.createECDH('secp256k1');
    let opts = { encoding: 'hex' };

    if (fs.existsSync(wallet)) {
        signing_key = fs.readFileSync(wallet, opts);
    }
    else {
        logger.info(`generating new wallet: '${wallet}'`);
        ecdh.generateKeys();

        signing_key = ecdh.getPrivateKey(opts.encoding);
        fs.writeFileSync(wallet, signing_key, opts);
    }

    ecdh.setPrivateKey(signing_key, opts.encoding);
    verifying_key = ecdh.getPublicKey(opts.encoding);
    my_address = pubkey_to_address(verifying_key);
    logger.info(`your address is ${my_address}`);

    return [ signing_key, verifying_key, my_address ];
}

// Misc. utilities
// ----------------------------------------------------------------------------

class BaseException extends Error {
    constructor(msg) {
        super(msg);
        this.msg = msg;
    }
}

class TxUnlockError extends BaseException {
}

class TxnValidationError extends BaseException {
    constructor(msg, to_orphan) {
        super(msg);
        this.to_orphan = to_orphan;
    }
}

class BlockValidationError extends BaseException {
    constructor(msg, to_orphan) {
        super(msg);
        this.to_orphan = to_orphan;
    }
}

/**
 * Class Mapping for deserialize
 */
const CLASSES_MAP = new Map([
    Block,
    TxIn,
    TxOut,
    Transaction,
    UnspentTxOut,
    OutPoint,
    GetBlocksMsg,
    InvMsg,
    GetUTXOsMsg,
    GetMempoolMsg,
    GetActiveChainMsg,
    AddPeerMsg
].map(cls => [ cls.name, cls ]));

function len(o) {
    if (o instanceof Map || o instanceof Set) {
        return o.size;
    }

    return o.length;
}

function bytes(o) {
    return Buffer.from(o + '', 'binary').toString('hex');
}

function serialize(obj) {
    return JSON.stringify(obj);
}

function deserialize(serialized) {

    function _type(T, args) {
        return new (CLASSES_MAP.get(T))(args);
    }

    function contents_to_objs(o) {
        if (Array.isArray(o)) {
            return o.map(function (item) {
                return contents_to_objs(item);
            });
        }

        if ('[object Object]' === {}.toString.call(o)) {
            let T = false;
            let obj = {};

            for (let [ k, v ] of Object.entries(o)) {
                if (k === '_type') {
                    T = v;
                }
                else {
                    obj[k] = contents_to_objs(v);
                }
            }

            if (T) {
                return _type(T, obj);
            }

            return obj;
        }

        return o;
    }

    return contents_to_objs(JSON.parse(serialized));
}

function sha256(s, encoding = null) {
    return crypto.createHash('sha256').update(s).digest(encoding);
}

function sha256d(s) {
    if (!(s instanceof Buffer)) {
        s = Buffer.from(s);
    }

    return sha256(sha256(s), 'hex');
}

function _chunks(l, n) {
    let chunks =[];
    for (let i = 0; i < l.length; i += n) {
        chunks.push(l.slice(i, i + n));
    }
    return chunks;
}

// Expose
// ----------------------------------------------------------------------------
exports.Params = Params;
exports.OutPoint = OutPoint;
exports.UnspentTxOut = UnspentTxOut;
exports.TxIn = TxIn;
exports.TxOut = TxOut;
exports.Transaction = Transaction;
exports.Block = Block;
exports.init_wallet = init_wallet;

exports.GetBlocksMsg = GetBlocksMsg;
exports.InvMsg = InvMsg;
exports.GetUTXOsMsg = GetUTXOsMsg;
exports.GetMempoolMsg = GetMempoolMsg;
exports.GetActiveChainMsg = GetActiveChainMsg;
exports.AddPeerMsg = AddPeerMsg;

exports.txn_iterator = txn_iterator;
exports.build_spend_message = build_spend_message;
exports.encode_socket_data = encode_socket_data;
exports.SocketMessageHandle = SocketMessageHandle;
exports.deserialize = deserialize;
exports.serialize = serialize;

exports.active_chain = active_chain;
exports.ACTIVE_CHAIN_IDX = ACTIVE_CHAIN_IDX;
exports.side_branches = side_branches;
exports.mempool = mempool;
exports.utxo_set = utxo_set;

exports.pubkey_to_address = pubkey_to_address;
exports.sha256d = sha256d;
exports.bytes = bytes;
exports.get_merkle_root = get_merkle_root;
exports.get_median_time_past = get_median_time_past;
exports.connect_block = connect_block;
exports.add_to_utxo = add_to_utxo;
exports.reorg_if_necessary = reorg_if_necessary;

// Main
// ----------------------------------------------------------------------------
const PORT = process.env['TC_PORT'] || 9999;

(function main() {
    if (module.parent) {
        return;
    }

    load_from_disk();

    logger.info('[p2p] listening on %d', PORT);
    tcp_server(PORT);

    if (len(peer_hostnames)) {
        logger.info('start initial block download from %d peers', len(peer_hostnames));
        send_to_peer(new GetBlocksMsg(active_chain[len(active_chain) - 1].id));

        // Wait a maximum of 60 seconds for IBD to complete.
        setTimeout(mine_forever, 60000);
    }
    else {
        mine_forever();
    }
})();
