import mongoose, { Schema, Document } from 'mongoose';

export type RelayState =
  | 'CREATED'
  | 'VALIDATED'
  | 'AWAITING_CONFIRMATION'
  | 'FUNDING'
  | 'FUNDED'
  | 'SENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED'
  | 'RECOVERY_REQUIRED';

export interface ITransferOperation extends Document {
  /** Unique operation ID (uuid). */
  operationId: string;
  /** Idempotency key: relay:<userId>:<quoteId>. One execution per key, ever. */
  idempotencyKey: string;
  userId: mongoose.Types.ObjectId;
  relayAddressId: mongoose.Types.ObjectId;
  relayAddress: string;

  state: RelayState;
  stateHistory: Array<{ state: RelayState; at: Date; note?: string }>;

  requestedAmountNano: string;        // what destination should receive
  platformFeeNano: string;            // 2%
  fundingAmountNano: string;          // total sent to relay wallet
  forwardFeeEstimateNano: string;
  minReserveNano: string;
  totalDebitNano: string;             // requested + fee (+ funding carry)
  destinationAddress: string;

  fundingTxHash?: string;
  fundingActualNano?: string;         // verified on-chain received
  fundingNetworkFeeNano?: string;

  outgoingTxHash?: string;
  outgoingAmountNano?: string;        // actual sent to destination
  outgoingNetworkFeeNano?: string;

  relayResidualNano: string;          // remaining on relay after outgoing

  failureReason?: string;
  retryCount: number;
  expiresAt: Date;
  confirmedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const TransferOperationSchema = new Schema<ITransferOperation>(
  {
    operationId: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relayAddressId: { type: Schema.Types.ObjectId, ref: 'RelayAddress', required: true, index: true },
    relayAddress: { type: String, required: true, index: true },

    state: {
      type: String,
      enum: ['CREATED', 'VALIDATED', 'AWAITING_CONFIRMATION', 'FUNDING', 'FUNDED', 'SENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'RECOVERY_REQUIRED'],
      default: 'CREATED',
      index: true,
    },
    stateHistory: {
      type: [{ state: String, at: { type: Date, default: Date.now }, note: String }],
      default: [],
    },

    requestedAmountNano: { type: String, required: true },
    platformFeeNano: { type: String, required: true },
    fundingAmountNano: { type: String, required: true },
    forwardFeeEstimateNano: { type: String, required: true },
    minReserveNano: { type: String, required: true },
    totalDebitNano: { type: String, required: true },
    destinationAddress: { type: String, required: true },

    fundingTxHash: { type: String, index: true },
    fundingActualNano: { type: String },
    fundingNetworkFeeNano: { type: String },

    outgoingTxHash: { type: String, index: true },
    outgoingAmountNano: { type: String },
    outgoingNetworkFeeNano: { type: String },

    relayResidualNano: { type: String, default: '0' },

    failureReason: { type: String },
    retryCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: true },
    confirmedAt: { type: Date },
  },
  { timestamps: true }
);

TransferOperationSchema.index({ relayAddressId: 1, state: 1 });
TransferOperationSchema.index({ state: 1, updatedAt: 1 }); // reconciler sweep

export const TransferOperation = mongoose.model<ITransferOperation>('TransferOperation', TransferOperationSchema);
