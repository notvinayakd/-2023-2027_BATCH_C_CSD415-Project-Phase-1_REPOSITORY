import { network } from "hardhat";

const { ethers, provider } = await network.create();

const ONE_DAY = 24 * 60 * 60;
const SHIP_AMOUNT = ethers.parseEther("1");
const FEE = (SHIP_AMOUNT * 200n) / 10000n;
const FUND_VALUE = SHIP_AMOUNT + FEE;
const STAKE = ethers.parseEther("1");

type Row = { fn: string; path: string; gas: bigint };
const rows: Row[] = [];

async function record(fn: string, path: string, txPromise: Promise<any>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  rows.push({ fn, path, gas: receipt.gasUsed });
  return receipt;
}

async function deployEscrow(importer: any, exporter: any, a1: any, a2: any, a3: any, arbitrator: any, feeRecipient: any, consignmentId: string) {
  const factory = await ethers.getContractFactory("Escrow", importer);
  const tx = await factory.getDeployTransaction(
    exporter.address,
    SHIP_AMOUNT,
    consignmentId,
    ONE_DAY,
    ONE_DAY * 30,
    ONE_DAY * 60,
    [a1.address, a2.address, a3.address],
    arbitrator.address,
    feeRecipient.address,
    ONE_DAY,
  );
  const sentTx = await importer.sendTransaction(tx);
  const receipt = await sentTx.wait();
  rows.push({ fn: "constructor (deploy)", path: consignmentId, gas: receipt.gasUsed });
  const deployed = await factory.deploy(
    exporter.address,
    SHIP_AMOUNT,
    consignmentId + "-x",
    ONE_DAY,
    ONE_DAY * 30,
    ONE_DAY * 60,
    [a1.address, a2.address, a3.address],
    arbitrator.address,
    feeRecipient.address,
    ONE_DAY,
  );
  await deployed.waitForDeployment();
  return deployed;
}

async function main() {
  const [importer, exporter, a1, a2, a3, arbitrator, feeRecipient] =
    await ethers.getSigners();

  // ---------- PATH 1: Happy path (release on customs clearance) ----------
  {
    const escrow = await deployEscrow(importer, exporter, a1, a2, a3, arbitrator, feeRecipient, "HAPPY");
    await record("stakeAsAttestor", "happy", (escrow.connect(a1) as any).stakeAsAttestor({ value: STAKE }));
    await record("stakeAsAttestor", "happy", (escrow.connect(a2) as any).stakeAsAttestor({ value: STAKE }));
    await record("stakeAsAttestor", "happy", (escrow.connect(a3) as any).stakeAsAttestor({ value: STAKE }));
    await record("accept", "happy", (escrow.connect(exporter) as any).accept());
    await record("deposit", "happy", (escrow.connect(importer) as any).deposit({ value: FUND_VALUE }));
    const recordHash1 = ethers.keccak256(ethers.toUtf8Bytes("dispatched"));
    await record("attest (1st vote, dispatched)", "happy", (escrow.connect(a1) as any).attest(3, recordHash1));
    await record("attest (2nd vote -> Shipped)", "happy", (escrow.connect(a2) as any).attest(3, recordHash1));
    const recordHash2 = ethers.keccak256(ethers.toUtf8Bytes("cleared"));
    await record("attest (1st vote, cleared)", "happy", (escrow.connect(a1) as any).attest(4, recordHash2));
    await record("attest (2nd vote -> CustomsCleared)", "happy", (escrow.connect(a2) as any).attest(4, recordHash2));
    await record("withdraw", "happy", (escrow.connect(exporter) as any).withdraw());
    await record("withdrawStake", "happy", (escrow.connect(a1) as any).withdrawStake());
    await record("withdrawStake", "happy", (escrow.connect(a2) as any).withdrawStake());
    await record("withdrawStake", "happy", (escrow.connect(a3) as any).withdrawStake());
  }

  // ---------- PATH 2: Refund (importer never dispatched in time) ----------
  {
    const escrow = await deployEscrow(importer, exporter, a1, a2, a3, arbitrator, feeRecipient, "REFUND");
    await record("accept", "refund", (escrow.connect(exporter) as any).accept());
    await record("deposit", "refund", (escrow.connect(importer) as any).deposit({ value: FUND_VALUE }));
    await provider.send("evm_increaseTime", [ONE_DAY * 31]);
    await provider.send("evm_mine", []);
    await record("refund", "refund", (escrow.connect(importer) as any).refund());
  }

  // ---------- PATH 3: Dispute resolved by arbitrator ----------
  {
    const escrow = await deployEscrow(importer, exporter, a1, a2, a3, arbitrator, feeRecipient, "ARBDISPUTE");
    await (escrow.connect(a1) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(a2) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(a3) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(exporter) as any).accept();
    await (escrow.connect(importer) as any).deposit({ value: FUND_VALUE });
    const recordHash = ethers.keccak256(ethers.toUtf8Bytes("held"));
    await record("attest (1st vote, held=99)", "arbdispute", (escrow.connect(a1) as any).attest(99, recordHash));
    await record("attest (2nd vote -> Disputed)", "arbdispute", (escrow.connect(a2) as any).attest(99, recordHash));
    await record("resolveDispute", "arbdispute", (escrow.connect(arbitrator) as any).resolveDispute(true));
    await record("withdrawStake", "arbdispute", (escrow.connect(a1) as any).withdrawStake());
  }

  // ---------- PATH 4: Timeout -> slashing -> forceResolveDispute -> claimSlashed ----------
  {
    const escrow = await deployEscrow(importer, exporter, a1, a2, a3, arbitrator, feeRecipient, "TIMEOUT");
    await (escrow.connect(a1) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(a2) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(a3) as any).stakeAsAttestor({ value: STAKE });
    await (escrow.connect(exporter) as any).accept();
    await (escrow.connect(importer) as any).deposit({ value: FUND_VALUE });
    const recordHash = ethers.keccak256(ethers.toUtf8Bytes("dispatched"));
    await (escrow.connect(a1) as any).attest(3, recordHash);
    await (escrow.connect(a2) as any).attest(3, recordHash);
    await provider.send("evm_increaseTime", [ONE_DAY * 61]);
    await provider.send("evm_mine", []);
    await record("checkTimeout (slashes 3 attestors)", "timeout", (escrow.connect(importer) as any).checkTimeout());
    await provider.send("evm_increaseTime", [ONE_DAY * 2]);
    await provider.send("evm_mine", []);
    await record("forceResolveDispute", "timeout", (escrow.connect(importer) as any).forceResolveDispute());
    await record("claimSlashed", "timeout", (escrow.connect(feeRecipient) as any).claimSlashed());
    await record("withdrawStake (post-slash)", "timeout", (escrow.connect(a1) as any).withdrawStake());
  }

  console.log("===GASTABLE_START===");
  console.log(JSON.stringify(rows.map(r => ({ fn: r.fn, path: r.path, gas: r.gas.toString() })), null, 2));
  console.log("===GASTABLE_END===");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
