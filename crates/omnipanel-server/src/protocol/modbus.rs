use serde::{Deserialize, Serialize};

/// Modbus 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ModbusConfig {
    pub host: String,
    pub port: u16,
    pub slave_id: u8,
    pub mode: String, // "tcp" or "rtu"
}

/// Modbus 会话。
pub struct ModbusSession {
    _config: ModbusConfig,
    pub connected: bool,
}

impl ModbusSession {
    pub fn connect(config: ModbusConfig) -> Result<Self, String> {
        // Stub: mark as connected
        Ok(Self {
            _config: config,
            connected: true,
        })
    }

    pub fn read_coils(&self, _addr: u16, _qty: u16) -> Result<Vec<bool>, String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        // Stub: return simulated data
        Ok(vec![true, false, true, false, true])
    }

    pub fn read_discrete_inputs(&self, _addr: u16, _qty: u16) -> Result<Vec<bool>, String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(vec![false, true, false, true])
    }

    pub fn read_holding_registers(&self, _addr: u16, _qty: u16) -> Result<Vec<u16>, String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(vec![100, 200, 300, 400, 500])
    }

    pub fn read_input_registers(&self, _addr: u16, _qty: u16) -> Result<Vec<u16>, String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(vec![10, 20, 30, 40])
    }

    pub fn write_single_coil(&mut self, _addr: u16, _value: bool) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(())
    }

    pub fn write_single_register(&mut self, _addr: u16, _value: u16) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(())
    }

    pub fn write_multiple_coils(&mut self, _addr: u16, _values: Vec<bool>) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(())
    }

    pub fn write_multiple_registers(
        &mut self,
        _addr: u16,
        _values: Vec<u16>,
    ) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".into());
        }
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<(), String> {
        self.connected = false;
        Ok(())
    }
}
