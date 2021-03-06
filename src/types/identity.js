import Promise from 'bluebird';
import BigNumber from 'bignumber.js';
import abi from 'ethereumjs-abi';
import utils from 'ethereumjs-util';
import t from 'tcomb';
import Web3 from 'web3';
import { Address } from './base';


export const BaseIdentity = t.struct({
  address: Address,
}, 'BaseIdentity');

Object.assign(BaseIdentity.prototype, {
  /**
   * The address that pays gas for transactions sent by this identity.
   */
  getGasAddress() {
    return this.address;
  },

  /**
   * Get the balance of the key that funds transactions and the current gas price.
   */
  getGasAffordability(provider) {
    const web3 = new Web3(provider);
    const getBalance = Promise.promisify(web3.eth.getBalance);
    const getGasPrice = Promise.promisify(web3.eth.getGasPrice);
    const address = this.getGasAddress();
    return Promise.all([getBalance(address), getGasPrice()])
      .then(([balance, gasPrice]) => ({ address, balance, gasPrice }));
  },

  /**
   * Wrap the transaction for a synthentic identity before passing it off to
   * a provider that can sign it.
   *
   * This default implementation is a no-op for key identities.
   */
  wrapTransaction(txParams) {
    return txParams;
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
export const ContractIdentity = BaseIdentity.extend({
  methodName: ContractIdentityMethod,
  methodVersion: t.String,
  key: Address,
}, 'ContractIdentity');

Object.assign(ContractIdentity.prototype, {
  getGasAddress() {
    return this.key;
  },

  wrapTransaction(txParams) {
    // Generate the data for the proxy contract call.
    const outerTxData = abi.simpleEncode(
      'forward(address,uint256,bytes)',
      txParams.to,
      txParams.value || 0,
      utils.toBuffer(txParams.data),
    );

    // Insert the proxy contract call data in a new transaction sent from the
    // specified identity.
    const newParams = {
      data: `0x${outerTxData.toString('hex')}`,
      to: this.address,
      from: this.key,
    };

    if (txParams.gas != null) {
      // The gas delta between sending a transaction normally and sending it
      // via Proxy.forward().
      const FORWARD_GAS = 21407;
      // The amount of gas Solidity reserves when it makes an external call. The
      // proxy contract makes an external call to forward the call, so it will
      // reserve CALL_GAS after using some of FORWARD_GAS.
      const CALL_GAS = 34050;
      const totalGas = new BigNumber(txParams.gas).add(FORWARD_GAS).add(CALL_GAS);
      newParams.gas = `0x${totalGas.toString(16)}`;
    }

    if (txParams.gasPrice != null) {
      newParams.gasPrice = txParams.gasPrice;
    }

    return newParams;
  },
});

export const SenderIdentity = t.refinement(
  ContractIdentity,
  (id) => id.methodName === 'sender',
  'SenderIdentity'
);

// NOTE: Owner identities that allow any sender to submit a metatransaction
// signed by the owner are not currently implemented.
export const OwnerIdentity = t.refinement(
  ContractIdentity.extend({
    owner: Address,
  }),
  (id) => id.methodName.startsWith('owner'),
  'OwnerIdentity'
);

/**
 * A union of all identity types.
 */
export const Identity = t.union([BaseIdentity, SenderIdentity, OwnerIdentity], 'Identity');
Identity.dispatch = function dispatch(data) {
  if (data.methodName == null) {
    return BaseIdentity;
  }

  const contractMethods = {
    'sender': SenderIdentity,
    'owner.metatx': OwnerIdentity,
  };
  return contractMethods[data.methodName];
};
