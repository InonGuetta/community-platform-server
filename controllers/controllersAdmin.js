import * as servicesAdmin from "../services/servicesAdmin.js";

export const getStats = async (req, res) => {
  const stats = await servicesAdmin.getStats();
  res.status(200).json(stats);
};

export const getQueueStatus = async (req, res) => {
  const status = await servicesAdmin.getQueueStatus();
  res.status(200).json(status);
};

export const getSystemHealth = async (req, res) => {
  const health = await servicesAdmin.getSystemHealth();
  res.status(200).json(health);
};
