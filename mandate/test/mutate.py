# Planted faults: each mutation of src/MandateBox.sol must make at least one test fail. Run: python3 test/mutate.py
import subprocess, shutil, os, sys
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
env=dict(os.environ); env['PATH']+=':'+os.path.expanduser('~/.foundry/bin')
M=[
 ('src/MandateBox.sol','if (!anyPayee && !isPayee[to]) return (Refusal.PayeeNotAllowed, 0);','','payee check removed'),
 ('src/MandateBox.sol','if (_transferDigest(t, nonce) != hash) return Refusal.NotThisTransfer;','','digest match removed'),
 ('src/MandateBox.sol','if (value > maxPerPayment) return (Refusal.OverPerPayment, 0);','','per-payment cap removed'),
 ('src/MandateBox.sol','usedByPay[nonce] = true;','','pay() slot not recorded'),
 ('src/MandateBox.sol','if (usdc.authorizationState(address(this), nonce)) revert Refused(Refusal.SlotUsed);','','pay() ignores x402-used slot'),
 ('src/MandateBox.sol','if (paused) return (Refusal.Paused, 0);','','pause ignored'),
 ('src/MandateBox.sol','if (msg.sender != a) revert Refused(Refusal.NotAgent);','','any caller may pay'),
 ('src/MandateBox.sol','return keccak256(abi.encode(address(this), day, slot));','return keccak256(abi.encode(address(this), slot));','nonce ignores the day'),
 ('src/MandateBox.sol','function withdraw(address to, uint256 value) external onlyOwner {','function withdraw(address to, uint256 value) external {','withdraw open to anyone'),
 ('src/MandateBox.sol','if (_initialized) revert AlreadyInitialized();','','re-initialise allowed'),
 ('src/MandateBox.sol','if (slot >= maxPaymentsPerDay) return (Refusal.OverDailyCount, 0);','','daily count removed'),
 ('src/MandateBox.sol','if (block.timestamp >= expiresAt) return (Refusal.Expired, 0);','','expiry ignored'),
 ('src/MandateBox.sol','if (!_signedByAgent(a, hash, t.agentSig)) return Refusal.BadAgentSignature;','','agent signature not checked'),
 ('src/MandateBox.sol','if (err == ECDSA.RecoverError.NoError && rec == a) return true;','if (err == ECDSA.RecoverError.NoError) return true;','any recovered key accepted'),
 ('src/MandateBox.sol','if (err == ECDSA.RecoverError.NoError && rec == a) return true;','','EOA path removed (7702 agent)'),
 ('src/MandateBox.sol','if (maxPerPayment_ > MAX_PER_PAYMENT) revert PerPaymentTooHigh();','','per-payment ceiling removed'),
 ('src/MandateBox.sol','if (expiresAt_ > block.timestamp + MAX_DURATION) revert ExpiryTooFar();','','expiry ceiling removed'),
 ('src/MandateBox.sol','if (owner == address(0)) revert NotInitialized();','','implementation takes deposits'),
]
bad=0
for f,old,new,label in M:
    src=open(f).read(); assert old in src, label
    shutil.copy(f,f+'.orig')
    open(f,'w').write(src.replace(old,new,1))
    r=subprocess.run(['forge','test','--fuzz-runs','300'],capture_output=True,text=True,env=env)
    shutil.move(f+'.orig',f)
    out=r.stdout+r.stderr
    fails=[l.split(']')[1].split('(')[0].strip() for l in out.splitlines() if l.startswith('[FAIL')]
    status='CAUGHT' if r.returncode!=0 and fails else ('COMPILE-ERR' if 'Compiler run failed' in out else 'MISSED')
    if status!='CAUGHT': bad+=1
    print(f'{status:8} {label:32} failing: {", ".join(fails[:4])}')
print('missed:',bad)
sys.exit(1 if bad else 0)   # a planted fault that no test catches fails the run
