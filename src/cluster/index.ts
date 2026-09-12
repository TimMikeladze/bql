// The public surface of the cluster control plane: the pure Raft state machine, the replicated
// state it carries, its durable log, its socket, and `ClusterNode` — the one thing the rest of
// BunQL calls. `docs/plan-phase2.md` C1, design §5.3.

export {
  type ClusterNodeOptions,
  ClusterNode,
  type ClusterView,
  type ClusterViewDb,
  type ClusterViewNode,
  type LeaseHandle,
} from "./node.ts"
export {
  decodeEntry,
  encodeEntry,
  type DecodedEntry,
  RaftLog,
  type RaftLogOptions,
} from "./log.ts"
export {
  type ConfigChange,
  decodeConfigChange,
  encodeConfigChange,
  type EntryKind,
  type HardState,
  type LogEntry,
  type ProposalId,
  Raft,
  type RaftAction,
  type RaftCommand,
  type RaftInput,
  type RaftMessage,
  type RaftOptions,
  type RaftRole,
  type RaftSnapshot,
} from "./raft.ts"
export {
  type ClusterFacts,
  decidePromotion,
  type FailoverInput,
  pickFailover,
  type PromotionDecision,
  type PromotionInput,
  type PromotionOutcome,
  type PromotionOutcomeCode,
  type PromotionRefusal,
  type PromotionRequest,
} from "./promotion.ts"
export {
  apply,
  compareTxid,
  type ClusterState,
  ClusterFormatError,
  type Command,
  type DbState,
  decodeCommand,
  decodeSnapshot,
  emptyState,
  encodeCommand,
  encodeSnapshot,
  type Lease,
  type NodeId,
  type NodeInfo,
  type NodeStatus,
  SNAPSHOT_VERSION,
} from "./state.ts"
export {
  decodeRaft,
  encodeRaft,
  RAFT_FRAME,
  RAFT_PATH,
  raftUrl,
  type RaftReply,
  type RaftRequest,
  type RaftClientSocket,
  type RaftSocket,
  type RaftSocketData,
  type RaftSocketFactory,
  RaftTransport,
  type RaftTransportOptions,
  type RaftUpgradeHost,
} from "./transport.ts"
