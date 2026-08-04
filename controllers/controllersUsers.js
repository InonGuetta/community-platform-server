// @ts-check
import * as servicesUsers from "../services/servicesUsers.js";

export const getAllUsers = async (req, res) => {
  const users = await servicesUsers.getAllUsers();
  res.status(200).json(users);
};

export const getUserById = async (req, res) => {
  const user = await servicesUsers.getUserById(req.params.id);
  res.status(200).json(user);
};

export const createUser = async (req, res) => {
  const user = await servicesUsers.createUser(req.body);
  res.status(201).json(user);
};

export const updateUser = async (req, res) => {
  const user = await servicesUsers.updateUser(req.params.id, req.body);
  res.status(200).json(user);
};

export const deleteUser = async (req, res) => {
  const result = await servicesUsers.deleteUser(req.params.id);
  res.status(200).json(result);
};
