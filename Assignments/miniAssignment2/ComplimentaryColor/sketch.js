// Color Blending Tool
// The user types a base color as R, G, B. Mouse position rotates a sector (pie slice) around the color wheel.
// The hue under the sector is blended 50/50 with the base color.
// extended from Rune Madsen's Color Scheme Complimentary Example :https://printingcode.runemadsen.com/examples/color/scheme_complementary/index.html

let innerRadius = 100; // hole size
let outerRadius = 200; // ring size (also the radius of the sector)

let steps = 1; // resolution: 360 small segments make the ring look smooth
let sectorAngle = 360/15; // angular width of the rotating sector (24 degrees)
let sectorRadius = 220; // the sector reaches 20 pixels past the ring

// NEW: input fields for the base color
let rInput, gInput, bInput;

function setup() {
  createCanvas(800, 800);
  colorMode(HSB, 360, 100, 100);
  noStroke();

  // NEW: three number inputs for R, G, B (default 100, 150, 255)
  rInput = createInput('100', 'number');
  gInput = createInput('150', 'number');
  bInput = createInput('255', 'number');
  rInput.position(40, 220);
  gInput.position(40, 250);
  bInput.position(40, 280);
  rInput.size(60);
  gInput.size(60);
  bInput.size(60);
}

function draw() {
  background(100);
  drawRing();

  // NEW: labels next to the input fields
  fill(0);
  textSize(16);
  text('R', 20, 237);
  text('G', 20, 267);
  text('B', 20, 297);

  // Map mouseX to the sector angle (0–360)
  let angle = map(mouseX, 0, width, 0, 360, true);

  // NEW: base color from the RGB inputs (fixed, does not depend on the mouse)
  colorMode(RGB, 255);
  let baseColor = color(readInput(rInput), readInput(gInput), readInput(bInput));

  // NEW: color of the wheel under the sector (hue = sector angle)
  colorMode(HSB, 360, 100, 100);
  let sampledColor = color(angle % 360, 100, 100);

  // NEW: 50/50 blend. lerpColor mixes in the current color mode,
  // so switch to RGB for the mix and then back to HSB.
  colorMode(RGB, 255);
  let blendedColor = lerpColor(baseColor, sampledColor, 0.5);
  colorMode(HSB, 360, 100, 100);

  let squareWidth = width/2;

  // Square 1: base color
  fill(baseColor);
  rect(0, 0, squareWidth, height/6);

  // Square 2: blended color
  fill(blendedColor);
  rect(squareWidth, 0, squareWidth, height/6);

  // NEW: rotating sector, blended color over the wheel and base color outside it
  drawSector(angle, blendedColor, baseColor);
}

// NEW: read one input field as a number between 0 and 255
function readInput(input){
  let value = int(input.value());
  if (isNaN(value)) {
    value = 0; // empty field counts as 0
  }
  return constrain(value, 0, 255);
}

// NEW: sector (pie slice) with its center at the center of the wheel.
// Its angular width is sectorAngle (24 degrees) and it is centered on the given angle.
// It is drawn in two layers:
//   radius 0 to outerRadius            = blended color (the part over the wheel)
//   radius outerRadius to sectorRadius = base color (the part outside the wheel)
function drawSector(angle, blended, base){
  push();
  translate(width / 2, height / 2);
  let startAngle = radians(angle - sectorAngle/2);
  let endAngle = radians(angle + sectorAngle/2);

  // arc() takes the full width and height of the circle, so use 2 * radius

  // Layer 1: the whole sector out to sectorRadius in the base color
  fill(base);
  arc(0, 0, sectorRadius * 2, sectorRadius * 2, startAngle, endAngle, PIE);

  // Layer 2: the part over the wheel in the blended color, drawn on top,
  // so only the outer 20 pixels of layer 1 stay visible
  fill(blended);
  arc(0, 0, outerRadius * 2, outerRadius * 2, startAngle, endAngle, PIE);
  pop();
}

function drawRing(){
  push();
  translate(width / 2, height / 2); // center of canvas

  

  for (let angle = 0; angle < 360; angle+=steps) {
    // overlap the next segment a little so no thin gaps show between segments
    let nextAngle = angle + steps + 0.5;

    // Outer edge points
    let x1 = cos(radians(angle)) * outerRadius;
    let y1 = sin(radians(angle)) * outerRadius;
    let x2 = cos(radians(nextAngle)) * outerRadius;
    let y2 = sin(radians(nextAngle)) * outerRadius;

    // Inner edge points
    let x3 = cos(radians(nextAngle)) * innerRadius;
    let y3 = sin(radians(nextAngle)) * innerRadius;
    let x4 = cos(radians(angle)) * innerRadius;
    let y4 = sin(radians(angle)) * innerRadius;

    fill(angle, 100, 100);
    quad(x1, y1, x2, y2, x3, y3, x4, y4);
   
  }
  pop();

}