use omnipanel_error::{ErrorCode, OmniError, OmniResult};
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
    pub fn connect(config: ModbusConfig) -> OmniResult<Self> {
        // Stub: mark as connected
        Ok(Self {
            _config: config,
            connected: true,
        })
    }

    pub fn read_coils(&self, _addr: u16, _qty: u16) -> OmniResult<Vec<bool>> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        // Stub: return simulated data
        Ok(vec![true, false, true, false, true])
    }

    pub fn read_discrete_inputs(&self, _addr: u16, _qty: u16) -> OmniResult<Vec<bool>> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(vec![false, true, false, true])
    }

    pub fn read_holding_registers(&self, _addr: u16, _qty: u16) -> OmniResult<Vec<u16>> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(vec![100, 200, 300, 400, 500])
    }

    pub fn read_input_registers(&self, _addr: u16, _qty: u16) -> OmniResult<Vec<u16>> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(vec![10, 20, 30, 40])
    }

    pub fn write_single_coil(&mut self, _addr: u16, _value: bool) -> OmniResult<()> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(())
    }

    pub fn write_single_register(&mut self, _addr: u16, _value: u16) -> OmniResult<()> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(())
    }

    pub fn write_multiple_coils(&mut self, _addr: u16, _values: Vec<bool>) -> OmniResult<()> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(())
    }

    pub fn write_multiple_registers(
        &mut self,
        _addr: u16,
        _values: Vec<u16>,
    ) -> OmniResult<()> {
        if !self.connected {
            return Err(OmniError::new(ErrorCode::Connection, "Not connected"));
        }
        Ok(())
    }

    pub fn disconnect(&mut self) -> OmniResult<()> {
        self.connected = false;
        Ok(())
    }
}
