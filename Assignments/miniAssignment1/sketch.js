function setup() {
  createCanvas(500, 500);
  noLoop();

  // Background
  background(255, 235, 200);
  noStroke();

  // Hair (back of the bob)
  fill(40, 30, 30);
  ellipse(250, 230, 300, 280);
  rect(100, 230, 300, 200);

  // Shirt
  fill(120, 170, 220);
  ellipse(250, 500, 260, 160);

  // Neck
  fill(250, 215, 185);
  rect(225, 370, 50, 60);

  // Face
  ellipse(250, 270, 230, 250);

  // Bangs
  fill(40, 30, 30);
  rect(140, 140, 220, 70);

  // Eyebrows
  triangle(185, 230, 215, 230, 200, 220);
  triangle(275, 230, 305, 230, 290, 220);

  // Eyes
  ellipse(200, 258, 30, 20);
  ellipse(295, 258, 30, 20);

  // Nose
  fill(230, 170, 140);
  triangle(250, 275, 244, 290, 256, 290);

  // Blush
  fill(255, 0, 0);
  circle(180, 300, 40);
  circle(320, 300, 40);

  // Mouth
  fill(150, 50, 60);
  ellipse(250, 320, 22, 10);
}
