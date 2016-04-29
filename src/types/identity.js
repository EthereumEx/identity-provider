import BN from 'bn.js';
import abi from 'ethereumjs-abi';
import utils from 'ethereumjs-util';
import t from 'tcomb';
import {Address, Identity} from './base';
import {State} from '../store';
import {deserialize} from '../keystore';

export const KeystoreIdentity = Identity.extend({}, 'KeystoreIdentity');

Object.assign(KeystoreIdentity.prototype, {
  signTransaction(txParams, state, callback) {
    const keystore = deserialize(state.keystore);
    keystore.passwordProvider = state.passwordProvider;
    keystore.signTransaction(txParams, callback);
  },
});


export const ContractIdentityMethod = t.enums({
  'sender': true,
  'owner.metatx': true,
});

/**
 * Defines a contract identity with a method to act as the identity on the
 * blockchain.
 *
 * Method versions should be thought of as a way to specify the protocol code that
 * is necessary to interact with the contracts, which will almost always be dependent
 * on the ABI of the proxy and owner contracts that implement the method.
 */
export const ContractIdentity = Identity.extend({
  methodName: ContractIdentityMethod,
  methodVersion: t.String,
  key: Address,
}, 'ContractIdentity');

Object.assign(ContractIdentity.prototype, {
  getGasAddress() {
    return this.key;
  },

  signTransaction(txParams, state, callback) {
    // Generate the data for the proxy contract call.
    // FIXME: ethereumjs-abi handles 0x-prefixed numbers in master, but not in 0.5.0.
    const forwardArgs = [
      new BN(utils.stripHexPrefix(txParams.to), 16),
      new BN(utils.stripHexPrefix(txParams.value), 16),
      utils.toBuffer(txParams.data),
    ];
    const outerTxData = abi.rawEncode(
      'forward', ['address', 'uint256', 'bytes'], forwardArgs);

    // Insert the proxy contract call data in a new transaction sent from the
    // specified identity.
    const newParams = {
      data: `0x${outerTxData.toString('hex')}`,
      to: this.address,
      from: this.key,
    };
    // If gasPrice or gasLimit were set, copy them over.
    // TODO: It is more accurate to add the ProxyContract.forward gas cost overhead
    // to the provided gasLimit as long as it's less than the block gas limit.
    ['gasPrice', 'gasLimit'].forEach((param) => {
      if (txParams[param] != null) {
        newParams[param] = txParams[param];
      }
    });

    const senderIdentity = State(state).identityForAddress(this.key);
    Transactable(senderIdentity).signTransaction(newParams, state, callback);
  },
});

export const SenderIdentity = t.refinement(
  ContractIdentity,
  (id) => id.methodName === 'sender',
  'SenderIdentity'
);

export const OwnerIdentity = t.refinement(
  ContractIdentity.extend({
    owner: Address,
  }),
  (id) => id.methodName.startsWith('owner'),
  'OwnerIdentity'
);

/**
 * A union of all types where signTransaction can be called successfully.
 *
 * e.g. Transactable(identity).signTransaction(...);
 */
export const Transactable = t.union([KeystoreIdentity, SenderIdentity], 'Transactable');
Transactable.dispatch = function (data) {
  if (data.methodName == null) {
    return KeystoreIdentity;
  }

  const contractMethods = {
    'sender': SenderIdentity,
  };
  return contractMethods[data.methodName];
};
