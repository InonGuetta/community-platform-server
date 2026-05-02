import * as servicesAdmin from "../services/servicesAdmin.js";

export const getStats = async (req, res) => {
  try {
    const stats = await servicesAdmin.getStats();
    res.status(200).json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getQueueStatus = async (req, res) => {
  try {
    const status = await servicesAdmin.getQueueStatus();
    res.status(200).json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getSystemHealth = async (req, res) => {
  try {
    const health = await servicesAdmin.getSystemHealth();
    res.status(200).json(health);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
