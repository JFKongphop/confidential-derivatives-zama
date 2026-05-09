// Shim for @zama-fhe/react-sdk/wagmi compatibility.
// The SDK was compiled against wagmi <2.14 which exported `watchConnection` (singular).
// Wagmi 2.14+ renamed it to `watchConnections` (plural). This re-exports everything
// from wagmi/actions and aliases the old name so the SDK build doesn't crash.
export * from 'wagmi/actions';
export { watchConnections as watchConnection } from 'wagmi/actions';
