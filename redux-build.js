import pkg from '@reduxjs/toolkit';
const { configureStore } = pkg;

import LCD from "raspberrypi-liquid-crystal";
const lcd = new LCD(1, 0x27, 16, 2);

import { Gpio } from "onoff";
const led = new Gpio(17, "out");
const button = new Gpio(27, "in", "rising", { debounceTimeout: 10 });

import aht20 from "aht20-sensor";

const getRandomArbitrary = (min, max) => {
  return Math.random() * (max - min) + min;
}

const formatFloat = (number, decimalPlaces = 1) => {
  if (number === null) {
    return 0;
  }
  
  let rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  
  return rounded.toFixed(decimalPlaces);
}

const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null
  },
  display: {
    mode: 'DEFAULT',
    isBacklit: false,
  },
  timer: {
    isActive: false,
    timeoutId: null,
    remaining: null
  }
}

function appReducer(state = initialState, action) {
  switch (action.type) {
    case 'data/temperature/internal':
      return { 
        ...state, 
        data: {
          ...state.data,
          temperature_internal: action.payload 
        }
      }
    case 'data/temperature/external':
      return { 
        ...state, 
        data: {
          ...state.data,
          temperature_external: action.payload 
        }
      }
    case 'data/humidity/internal':
      return { 
        ...state, 
        data: {
          ...state.data,
          humidity_internal: action.payload 
        }
      }
    case 'data/pressure':
      return { 
        ...state, 
        data: {
          ...state.data,
          pressure: action.payload 
        }
      }
    case 'display/backlight':
      return { 
        ...state, 
        display :{
          ...state.display,
          isBacklit: true 
        }
      }
    default:
      return state
  }
}

let store = configureStore({reducer: appReducer})

store.subscribe(() => {
  // console.log(store.getState())
})

// https://github.com/ExodusMovement/redux-watch

const renderData = (data) => {
  console.log(`int: ${formatFloat(data.temperature_internal)}c ${formatFloat(data.humidity_internal)}%`);
  console.log(`ext: ${formatFloat(data.temperature_external)}c`);

  lcd.clearSync();

  lcd.printLineSync(
    0,
    `int: ${formatFloat(data.temperature_internal)}c ${formatFloat(
      data.humidity_internal
    )}%`
  );
  lcd.printLineSync(1, `ext: ${formatFloat(data.temperature_external)}c`);
}

const renderTimer = (timer) => {
  if (timer.isActive) {
    console.log('timer countdown active');
    console.log(`${timer.remaining}mins remaining`);
  } else {
    console.log('timer countdown inactive');
    console.log('<action> to start a 60m countdown');
  }
}

const renderMessage = () => {
  console.log('what should this do?');
  console.log('write something from what input?');
}

// Startup

lcd.beginSync();
lcd.displaySync();

// LCD startup text

lcd.clearSync();
lcd.printLineSync(0, "starting up...");

// On LED

led.writeSync(1);

// Start polling data

const internalSensorPoll = setInterval(() => {
  aht20.open().then(async (sensor) => {
    const temp = await sensor.temperature();
    const hum = await sensor.humidity();

    console.log(temp, hum);

    store.dispatch({
      type: "data/temperature/internal",
      payload: temp,
    });
    store.dispatch({
      type: "data/humidity/internal",
      payload: hum,
    });
  });

  // store.dispatch({
  //   type: "data/temperature/internal",
  //   payload: getRandomArbitrary(10, 21),
  // });
  // store.dispatch({
  //   type: "data/humidity/internal",
  //   payload: getRandomArbitrary(55, 67),
  // });
  // store.dispatch({
  //   type: "data/pressure",
  //   payload: getRandomArbitrary(920, 1000),
  // });
}, 1000 * 5);

const ds18b20Mock = setInterval(() => {
  store.dispatch({
    type: "data/temperature/external",
    payload: getRandomArbitrary(7, 17),
  });
}, 3333);

// Start the render loop

const displayLoop = setInterval(() => {
  const state = store.getState();

  switch (state.display.mode) {
    case 'DEFAULT':
      renderData(state.data)
      return
    case 'TIMER':
      renderTimer(state.timer)
      return
    case 'MESSAGE':
      renderMessage()
      return
    default:
      return
  }
}, 2000);

process.on("SIGINT", (_) => {
  clearInterval(displayLoop);

  lcd.noDisplaySync();

  process.exit();
});