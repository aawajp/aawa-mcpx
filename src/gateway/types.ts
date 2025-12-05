import type { BackendManager } from '@/backend/types';
import type { TrafficStore } from '@/utils/trafficStore';

type StartServerParams = {
	port: number;
	backendManager: BackendManager;
	trafficStore: TrafficStore;
};

type ServerInstance = {
	stop: () => Promise<void>;
};

export type { StartServerParams, ServerInstance };
