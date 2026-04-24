import { useState, useCallback } from 'react';
import {
  getInstances,
  upsertInstance,
  removeInstance as removeFromConfig,
} from '../services/config';
import type { Instance } from '../types';

export interface InstancesState {
  instances: Instance[];
  reload:         () => void;
  addInstance:    (instance: Instance) => void;
  removeInstance: (id: string) => void;
  updateInstance: (instance: Instance) => void;
}

export function useInstances(): InstancesState {
  const [instances, setInstances] = useState<Instance[]>(() => getInstances());

  const reload = useCallback(() => {
    setInstances(getInstances());
  }, []);

  const addInstance = useCallback((instance: Instance) => {
    upsertInstance(instance);
    setInstances(getInstances());
  }, []);

  const updateInstance = useCallback((instance: Instance) => {
    upsertInstance(instance);
    setInstances(getInstances());
  }, []);

  const removeInstance = useCallback((id: string) => {
    removeFromConfig(id);
    setInstances(getInstances());
  }, []);

  return { instances, reload, addInstance, removeInstance, updateInstance };
}
