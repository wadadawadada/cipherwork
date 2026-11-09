//! CIPHERWORK OrderEscrow (NEAR testnet).
//!
//! TRUST MODEL (explicit): this contract does NOT verify Intel TDX / NVIDIA attestation.
//! It trusts ONE authorized verifier ed25519 key. A `settle_order` call is only accepted
//! when it carries a domain-separated verdict signed by that key. Anyone may relay the call.
//!
//! Money safety: integer yoctoNEAR only, monotonic state machine, pull payments
//! (`claim_balance`), no unbounded external calls, refund path independent of any backend.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult,
};

pub const DOMAIN: &str = "cipherwork.near.testnet.v1";
pub const CHAIN_ID: &str = "testnet";
const FEE_BPS_MAX: u16 = 1_000; // hard cap: 10%
const CLAIM_CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Funded,
    Settled,
    Rejected,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Order {
    pub order_id: String,
    pub buyer: AccountId,
    pub provider: AccountId,
    /// Escrowed amount available for the job (deposit minus storage fee), yoctoNEAR.
    pub max_pay: U128,
    pub storage_fee: U128,
    pub deadline_ms: u64,
    pub created_ms: u64,
    pub quote_digest: String,
    pub status: OrderStatus,
    pub proof_digest: Option<String>,
    pub provider_amount: Option<U128>,
    pub fee_amount: Option<U128>,
    pub verifier_key_id: Option<String>,
    pub finalized_ms: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Verdict {
    pub order_id: String,
    /// "verified" | "rejected"
    pub outcome: String,
    pub proof_digest: String,
    pub request_binding_digest: String,
    pub expiry_ms: u64,
    pub verifier_key_id: String,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub verifier_public_key_hex: String,
    pub verifier_key_id: String,
    pub fee_bps: u16,
    pub timelock_ms: u64,
    pub pending_verifier_public_key_hex: Option<String>,
    pub pending_verifier_activates_ms: Option<u64>,
    pub treasury: AccountId,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Orders,
    Balances,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OrderEscrow {
    owner: AccountId,
    treasury: AccountId,
    verifier_pk: [u8; 32],
    verifier_key_id: String,
    pending_pk: Option<([u8; 32], String, u64)>,
    timelock_ms: u64,
    fee_bps: u16,
    orders: LookupMap<String, Order>,
    balances: LookupMap<AccountId, u128>,
}

fn decode_hex32(s: &str) -> [u8; 32] {
    let b = decode_hex(s);
    require!(b.len() == 32, "ed25519 public key must be 32 bytes");
    let mut o = [0u8; 32];
    o.copy_from_slice(&b);
    o
}

fn decode_hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() % 2 == 0, "invalid hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| env::panic_str("invalid hex"))
        })
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn emit(event: &str, data: &str) {
    log!(
        "EVENT_JSON:{{\"standard\":\"cipherwork\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
        event,
        data
    );
}

/// Canonical message signed by the verifier. Field order is part of the protocol.
pub fn verdict_message(contract_id: &str, v: &Verdict) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        DOMAIN,
        contract_id,
        CHAIN_ID,
        v.order_id,
        v.outcome,
        v.proof_digest,
        v.request_binding_digest,
        v.expiry_ms
    )
}

#[near]
impl OrderEscrow {
    #[init]
    pub fn new(
        owner: AccountId,
        treasury: AccountId,
        verifier_public_key_hex: String,
        verifier_key_id: String,
        fee_bps: u16,
        timelock_ms: u64,
    ) -> Self {
        require!(!env::state_exists(), "already initialized");
        require!(fee_bps <= FEE_BPS_MAX, "fee above hard cap");
        Self {
            owner,
            treasury,
            verifier_pk: decode_hex32(&verifier_public_key_hex),
            verifier_key_id,
            pending_pk: None,
            timelock_ms,
            fee_bps,
            orders: LookupMap::new(Key::Orders),
            balances: LookupMap::new(Key::Balances),
        }
    }

    /// Create AND fund an order atomically. The attached deposit pays the on-chain storage
    /// fee first; the remainder becomes `max_pay`, frozen for `provider_id` until the deadline.
    #[payable]
    pub fn create_order(
        &mut self,
        order_id: String,
        provider_id: AccountId,
        deadline_ms: u64,
        quote_digest: String,
    ) -> Order {
        require!(
            order_id.len() >= 8 && order_id.len() <= 64,
            "order_id length must be 8..64"
        );
        require!(quote_digest.len() <= 128, "quote_digest too long");
        require!(!self.orders.contains_key(&order_id), "order already exists");
        let now = env::block_timestamp_ms();
        require!(deadline_ms > now, "deadline must be in the future");
        require!(
            deadline_ms <= now + 7 * 24 * 3600 * 1000,
            "deadline too far (max 7 days)"
        );
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "attach a deposit");
        let buyer = env::predecessor_account_id();
        require!(buyer != provider_id, "buyer and provider must differ");

        let before = env::storage_usage();
        let mut order = Order {
            order_id: order_id.clone(),
            buyer,
            provider: provider_id,
            max_pay: U128(0),
            storage_fee: U128(0),
            deadline_ms,
            created_ms: now,
            quote_digest,
            status: OrderStatus::Funded,
            proof_digest: None,
            provider_amount: None,
            fee_amount: None,
            verifier_key_id: None,
            finalized_ms: None,
        };
        self.orders.insert(order_id.clone(), order.clone());
        self.orders.flush();
        // Final-state fields add bytes later; reserve for the larger finalized record.
        let used = env::storage_usage().saturating_sub(before) + 400;
        let storage_fee = (used as u128) * env::storage_byte_cost().as_yoctonear();
        require!(deposit > storage_fee, "deposit does not cover storage fee");
        order.storage_fee = U128(storage_fee);
        order.max_pay = U128(deposit - storage_fee);
        self.orders.insert(order_id.clone(), order.clone());
        emit(
            "order_created",
            &format!(
                "{{\"order_id\":\"{}\",\"buyer\":\"{}\",\"provider\":\"{}\",\"max_pay\":\"{}\",\"deadline_ms\":{}}}",
                order.order_id, order.buyer, order.provider, order.max_pay.0, order.deadline_ms
            ),
        );
        order
    }

    /// Relayable. Requires a verifier signature over the canonical, domain-separated verdict.
    pub fn settle_order(&mut self, verdict: Verdict, signature_hex: String) -> Order {
        let now = env::block_timestamp_ms();
        require!(now <= verdict.expiry_ms, "verdict expired");
        require!(
            verdict.outcome == "verified" || verdict.outcome == "rejected",
            "unknown outcome"
        );
        require!(
            verdict.verifier_key_id == self.verifier_key_id,
            "unknown verifier key id"
        );
        let sig = decode_hex(&signature_hex);
        require!(sig.len() == 64, "signature must be 64 bytes");
        let mut sig64 = [0u8; 64];
        sig64.copy_from_slice(&sig);
        let msg = verdict_message(env::current_account_id().as_str(), &verdict);
        require!(
            env::ed25519_verify(&sig64, msg.as_bytes(), &self.verifier_pk),
            "invalid verifier signature"
        );

        let mut order = self
            .orders
            .get(&verdict.order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("order not found"));
        require!(
            order.status == OrderStatus::Funded,
            "order is not in Funded state"
        );
        require!(now <= order.deadline_ms, "order deadline passed; use request_refund");

        let max_pay = order.max_pay.0;
        if verdict.outcome == "verified" {
            let fee = max_pay * (self.fee_bps as u128) / 10_000u128;
            let to_provider = max_pay - fee;
            let provider = order.provider.clone();
            let treasury = self.treasury.clone();
            self.credit(&provider, to_provider);
            self.credit(&treasury, fee);
            order.status = OrderStatus::Settled;
            order.provider_amount = Some(U128(to_provider));
            order.fee_amount = Some(U128(fee));
        } else {
            let buyer = order.buyer.clone();
            self.credit(&buyer, max_pay);
            order.status = OrderStatus::Rejected;
            order.provider_amount = Some(U128(0));
            order.fee_amount = Some(U128(0));
        }
        order.proof_digest = Some(verdict.proof_digest.clone());
        order.verifier_key_id = Some(verdict.verifier_key_id.clone());
        order.finalized_ms = Some(now);
        self.orders.insert(order.order_id.clone(), order.clone());
        emit(
            "order_settled",
            &format!(
                "{{\"order_id\":\"{}\",\"outcome\":\"{}\",\"proof_digest\":\"{}\",\"verifier_key_id\":\"{}\"}}",
                order.order_id, verdict.outcome, verdict.proof_digest, verdict.verifier_key_id
            ),
        );
        order
    }

    /// Buyer-only. Works without any backend once the deadline has passed.
    pub fn request_refund(&mut self, order_id: String) -> Order {
        let mut order = self
            .orders
            .get(&order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("order not found"));
        require!(
            env::predecessor_account_id() == order.buyer,
            "only the buyer can request a refund"
        );
        require!(
            order.status == OrderStatus::Funded,
            "order is not in Funded state"
        );
        require!(
            env::block_timestamp_ms() > order.deadline_ms,
            "deadline not reached"
        );
        let buyer = order.buyer.clone();
        self.credit(&buyer, order.max_pay.0);
        order.status = OrderStatus::Refunded;
        order.finalized_ms = Some(env::block_timestamp_ms());
        self.orders.insert(order_id.clone(), order.clone());
        emit("order_refunded", &format!("{{\"order_id\":\"{}\"}}", order_id));
        order
    }

    /// Pull payment. Balance is zeroed BEFORE the transfer and restored if it fails.
    pub fn claim_balance(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.balances.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.balances.insert(who.clone(), 0);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CLAIM_CALLBACK_GAS)
                    .on_claim(who, U128(amount)),
            )
    }

    #[private]
    pub fn on_claim(&mut self, account: AccountId, amount: U128) -> bool {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                emit(
                    "balance_claimed",
                    &format!("{{\"account\":\"{}\",\"amount\":\"{}\"}}", account, amount.0),
                );
                true
            }
            _ => {
                let cur = self.balances.get(&account).copied().unwrap_or(0);
                self.balances.insert(account, cur + amount.0);
                false
            }
        }
    }

    /// Owner proposes a new verifier key; it can only be applied after `timelock_ms`.
    pub fn set_verifier_key(&mut self, public_key_hex: String, key_id: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let pk = decode_hex32(&public_key_hex);
        let at = env::block_timestamp_ms() + self.timelock_ms;
        self.pending_pk = Some((pk, key_id.clone(), at));
        emit(
            "verifier_key_proposed",
            &format!("{{\"key_id\":\"{}\",\"activates_ms\":{}}}", key_id, at),
        );
    }

    pub fn apply_verifier_key(&mut self) {
        let (pk, id, at) = self
            .pending_pk
            .clone()
            .unwrap_or_else(|| env::panic_str("no pending key"));
        require!(env::block_timestamp_ms() >= at, "timelock not elapsed");
        self.verifier_pk = pk;
        self.verifier_key_id = id.clone();
        self.pending_pk = None;
        emit("verifier_key_applied", &format!("{{\"key_id\":\"{}\"}}", id));
    }

    // ---- views ----
    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }
    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }
    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            verifier_public_key_hex: to_hex(&self.verifier_pk),
            verifier_key_id: self.verifier_key_id.clone(),
            fee_bps: self.fee_bps,
            timelock_ms: self.timelock_ms,
            pending_verifier_public_key_hex: self.pending_pk.as_ref().map(|p| to_hex(&p.0)),
            pending_verifier_activates_ms: self.pending_pk.as_ref().map(|p| p.2),
            treasury: self.treasury.clone(),
        }
    }
    pub fn get_domain(&self) -> String {
        format!("{}|{}|{}", DOMAIN, env::current_account_id(), CHAIN_ID)
    }
}

impl OrderEscrow {
    fn credit(&mut self, who: &AccountId, amount: u128) {
        let cur = self.balances.get(who).copied().unwrap_or(0);
        self.balances.insert(who.clone(), cur + amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn ctx(pred: AccountId, deposit: u128, ts_ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id("escrow.testnet".parse().unwrap())
            .predecessor_account_id(pred)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts_ms * 1_000_000);
        b
    }
    fn key() -> SigningKey {
        SigningKey::generate(&mut rand::rngs::OsRng)
    }
    fn setup(sk: &SigningKey) -> OrderEscrow {
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        OrderEscrow::new(
            accounts(0),
            accounts(4),
            to_hex(sk.verifying_key().as_bytes()),
            "k1".into(),
            500,
            0,
        )
    }
    fn mk(c: &mut OrderEscrow, id: &str, dl: u64) -> Order {
        testing_env!(ctx(accounts(1), ONE_NEAR, 1_000).build());
        c.create_order(id.into(), accounts(2), dl, "qd".into())
    }
    fn verdict(id: &str, outcome: &str, exp: u64) -> Verdict {
        Verdict {
            order_id: id.into(),
            outcome: outcome.into(),
            proof_digest: "pd".into(),
            request_binding_digest: "rb".into(),
            expiry_ms: exp,
            verifier_key_id: "k1".into(),
        }
    }
    fn sign(sk: &SigningKey, v: &Verdict) -> String {
        to_hex(&sk.sign(verdict_message("escrow.testnet", v).as_bytes()).to_bytes())
    }

    #[test]
    fn t06_successful_split_95_5() {
        let sk = key();
        let mut c = setup(&sk);
        let o = mk(&mut c, "order-0001", 100_000);
        let v = verdict("order-0001", "verified", 50_000);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        let s = c.settle_order(v.clone(), sign(&sk, &v));
        assert_eq!(s.status, OrderStatus::Settled);
        let fee = o.max_pay.0 * 500 / 10_000;
        assert_eq!(c.get_balance(accounts(2)).0, o.max_pay.0 - fee);
        assert_eq!(c.get_balance(accounts(4)).0, fee);
    }

    #[test]
    #[should_panic(expected = "order is not in Funded state")]
    fn t07_double_settlement_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0002", 100_000);
        let v = verdict("order-0002", "verified", 50_000);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(v.clone(), sign(&sk, &v));
        c.settle_order(v.clone(), sign(&sk, &v));
    }

    #[test]
    #[should_panic(expected = "invalid verifier signature")]
    fn forged_signature_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0003", 100_000);
        let v = verdict("order-0003", "verified", 50_000);
        let attacker = key();
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(v.clone(), sign(&attacker, &v));
    }

    #[test]
    #[should_panic(expected = "invalid verifier signature")]
    fn tampered_verdict_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0004", 100_000);
        let v = verdict("order-0004", "rejected", 50_000);
        let sig = sign(&sk, &v);
        let mut tampered = v.clone();
        tampered.outcome = "verified".into();
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(tampered, sig);
    }

    #[test]
    #[should_panic(expected = "invalid verifier signature")]
    fn wrong_contract_domain_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0005", 100_000);
        let v = verdict("order-0005", "verified", 50_000);
        let sig = to_hex(&sk.sign(verdict_message("other.testnet", &v).as_bytes()).to_bytes());
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(v, sig);
    }

    #[test]
    #[should_panic(expected = "verdict expired")]
    fn expired_verdict_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0006", 100_000);
        let v = verdict("order-0006", "verified", 1_500);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(v.clone(), sign(&sk, &v));
    }

    #[test]
    fn rejected_verdict_refunds_buyer_with_no_fee() {
        let sk = key();
        let mut c = setup(&sk);
        let o = mk(&mut c, "order-0007", 100_000);
        let v = verdict("order-0007", "rejected", 50_000);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        let s = c.settle_order(v.clone(), sign(&sk, &v));
        assert_eq!(s.status, OrderStatus::Rejected);
        assert_eq!(c.get_balance(accounts(1)).0, o.max_pay.0);
        assert_eq!(c.get_balance(accounts(2)).0, 0);
    }

    #[test]
    fn t08_expiry_refund_without_backend() {
        let sk = key();
        let mut c = setup(&sk);
        let o = mk(&mut c, "order-0008", 5_000);
        testing_env!(ctx(accounts(1), 0, 6_000).build());
        let r = c.request_refund("order-0008".into());
        assert_eq!(r.status, OrderStatus::Refunded);
        assert_eq!(c.get_balance(accounts(1)).0, o.max_pay.0);
    }

    #[test]
    #[should_panic(expected = "deadline not reached")]
    fn refund_before_deadline_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0009", 5_000);
        testing_env!(ctx(accounts(1), 0, 2_000).build());
        c.request_refund("order-0009".into());
    }

    #[test]
    #[should_panic(expected = "only the buyer")]
    fn refund_by_stranger_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0010", 5_000);
        testing_env!(ctx(accounts(3), 0, 6_000).build());
        c.request_refund("order-0010".into());
    }

    #[test]
    #[should_panic(expected = "order is not in Funded state")]
    fn refund_after_settlement_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0011", 100_000);
        let v = verdict("order-0011", "verified", 50_000);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.settle_order(v.clone(), sign(&sk, &v));
        testing_env!(ctx(accounts(1), 0, 200_000).build());
        c.request_refund("order-0011".into());
    }

    #[test]
    #[should_panic(expected = "deadline passed")]
    fn settle_after_deadline_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0012", 5_000);
        let v = verdict("order-0012", "verified", 50_000);
        testing_env!(ctx(accounts(3), 0, 6_000).build());
        c.settle_order(v.clone(), sign(&sk, &v));
    }

    #[test]
    #[should_panic(expected = "order already exists")]
    fn duplicate_order_rejected() {
        let sk = key();
        let mut c = setup(&sk);
        mk(&mut c, "order-0013", 100_000);
        mk(&mut c, "order-0013", 100_000);
    }

    #[test]
    fn storage_fee_is_charged_and_conserved() {
        let sk = key();
        let mut c = setup(&sk);
        let o = mk(&mut c, "order-0014", 100_000);
        assert!(o.storage_fee.0 > 0);
        assert_eq!(o.storage_fee.0 + o.max_pay.0, ONE_NEAR);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_sets_verifier_key() {
        let sk = key();
        let mut c = setup(&sk);
        testing_env!(ctx(accounts(3), 0, 2_000).build());
        c.set_verifier_key(to_hex(key().verifying_key().as_bytes()), "k2".into());
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn verifier_key_rotation_is_timelocked() {
        let sk = key();
        testing_env!(ctx(accounts(0), 0, 1_000).build());
        let mut c = OrderEscrow::new(
            accounts(0),
            accounts(4),
            to_hex(sk.verifying_key().as_bytes()),
            "k1".into(),
            500,
            10_000,
        );
        c.set_verifier_key(to_hex(key().verifying_key().as_bytes()), "k2".into());
        c.apply_verifier_key();
    }
}
