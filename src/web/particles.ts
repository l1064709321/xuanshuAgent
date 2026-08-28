// ========== 粒子云画布 ==========

export function initParticles(): void {
  const canvas = document.getElementById("particleCanvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  let w: number, h: number;

  const particles: Particle[] = [];
  const PARTICLE_COUNT = 80;

  function resize(): void {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  function getParticleColor(): { r: number; g: number; b: number } {
    const style = getComputedStyle(document.documentElement);
    const raw = style.getPropertyValue("--neon-cyan").trim() || "#00f0ff";
    if (raw.startsWith("#")) {
      const r = parseInt(raw.slice(1, 3), 16);
      const g = parseInt(raw.slice(3, 5), 16);
      const b = parseInt(raw.slice(5, 7), 16);
      return { r, g, b };
    }
    return { r: 0, g: 240, b: 255 };
  }

  class Particle {
    x = 0; y = 0; vx = 0; vy = 0; radius = 1; opacity = 0.2;
    reset(): void {
      this.x = Math.random() * w;
      this.y = Math.random() * h;
      this.vx = (Math.random() - 0.5) * 0.4;
      this.vy = (Math.random() - 0.5) * 0.4;
      this.radius = Math.random() * 2 + 0.5;
      this.opacity = Math.random() * 0.4 + 0.1;
    }
    constructor() { this.reset(); }
    update(): void {
      this.x += this.vx;
      this.y += this.vy;
      if (this.x < 0 || this.x > w) this.vx *= -1;
      if (this.y < 0 || this.y > h) this.vy *= -1;
    }
    draw(c: CanvasRenderingContext2D, color: { r: number; g: number; b: number }): void {
      c.beginPath();
      c.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      c.fillStyle = "rgba(" + color.r + "," + color.g + "," + color.b + "," + this.opacity + ")";
      c.fill();
    }
  }

  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(new Particle());

  let mouseX = -100, mouseY = -100;
  document.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; });

  function animate(): void {
    ctx.clearRect(0, 0, w, h);
    const color = getParticleColor();

    particles.forEach(p => { p.update(); p.draw(ctx, color); });

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          const lineOpacity = 0.06 * (1 - dist / 100);
          ctx.strokeStyle = "rgba(" + color.r + "," + color.g + "," + color.b + "," + lineOpacity + ")";
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
      const dmx = particles[i].x - mouseX;
      const dmy = particles[i].y - mouseY;
      const dm = Math.sqrt(dmx * dmx + dmy * dmy);
      if (dm < 150) {
        particles[i].vx += dmx / dm * 0.02;
        particles[i].vy += dmy / dm * 0.02;
      }
    }

    particles.forEach(p => { p.vx *= 0.999; p.vy *= 0.999; });
    requestAnimationFrame(animate);
  }
  animate();
}
