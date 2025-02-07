import { randomBytes } from 'crypto';
import { generateId, getHexString } from '../../../../lib/Utils';
import {
  OrderSide,
  SwapUpdateEvent,
  SwapVersion,
} from '../../../../lib/consts/Enums';
import ChainSwapData from '../../../../lib/db/models/ChainSwapData';
import { NodeType } from '../../../../lib/db/models/ReverseSwap';
import ChainSwapRepository from '../../../../lib/db/repositories/ChainSwapRepository';
import ReverseSwapRepository from '../../../../lib/db/repositories/ReverseSwapRepository';

export const createReverseSwap = async (
  status = SwapUpdateEvent.ChannelCreated,
) => {
  return ReverseSwapRepository.addReverseSwap({
    status,
    fee: 123,
    id: generateId(),
    pair: 'L-BTC/BTC',
    node: NodeType.CLN,
    onchainAmount: 90_000,
    invoiceAmount: 100_000,
    orderSide: OrderSide.BUY,
    timeoutBlockHeight: 84321,
    version: SwapVersion.Taproot,
    invoice: `lnbc1${generateId()}`,
    lockupAddress: `bc1q${generateId()}`,
    preimageHash: getHexString(randomBytes(32)),
  });
};

export const createChainSwap = async (
  status = SwapUpdateEvent.SwapCreated,
  sendingTimeoutBlockHeight = 813411,
) => {
  const chainSwap = {
    status,
    id: generateId(),
    pair: 'L-BTC/BTC',
    orderSide: OrderSide.BUY,
    fee: 123,
    acceptZeroConf: false,
    preimageHash: getHexString(randomBytes(32)),
  };

  const sendingData = {
    swapId: chainSwap.id,
    symbol: 'L-BTC',
    lockupAddress: `bc1q${generateId()}`,
    expectedAmount: 123321,
    timeoutBlockHeight: sendingTimeoutBlockHeight,
  };
  const receivingData = {
    swapId: chainSwap.id,
    symbol: 'BTC',
    lockupAddress: `lq1${generateId()}`,
    expectedAmount: 123500,
    timeoutBlockHeight: 2132435,
  };

  await ChainSwapRepository.addChainSwap({
    chainSwap,
    sendingData,
    receivingData,
  });

  return {
    chainSwap,
    sendingData: sendingData as Partial<ChainSwapData>,
    receivingData: receivingData as Partial<ChainSwapData>,
  };
};
